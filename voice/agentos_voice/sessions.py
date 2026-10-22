import asyncio
import json
import logging
from contextlib import suppress
from dataclasses import dataclass
from datetime import timedelta
from uuid import UUID

from agentos.console.v1.speech_pb2 import VoiceCallConnection
from agentos.voice.v1.worker_pb2 import EndSessionRequest, StartSessionRequest
from fastapi import HTTPException
from livekit import api
from livekit.plugins import silero

from agentos_voice.pipeline import Call

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Configuration:
    url: str
    public_url: str
    api_key: str
    api_secret: str
    capacity: int = 4


@dataclass
class Session:
    owner: str
    call: Call
    task: asyncio.Task


class Sessions:
    def __init__(self, configuration: Configuration, vad: silero.VAD):
        self.configuration = configuration
        self.vad = vad
        self.livekit = api.LiveKitAPI(
            configuration.url, configuration.api_key, configuration.api_secret
        )
        self.active: dict[str, Session] = {}
        self.lock = asyncio.Lock()
        self.closing = False

    def token(self, call_id: str, participant: str):
        token = (
            api.AccessToken(self.configuration.api_key, self.configuration.api_secret)
            .with_identity(participant)
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=call_id,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_data=True,
                    can_publish_sources=["microphone"],
                )
            )
            .with_ttl(timedelta(minutes=5))
        )
        if participant == "assistant":
            token = token.with_kind("agent")
        return token.to_jwt()

    async def ready(self):
        if self.closing:
            raise HTTPException(503)
        async with asyncio.timeout(2):
            await self.livekit.room.list_rooms(api.ListRoomsRequest(names=["agentos-readiness"]))

    async def start(self, request: StartSessionRequest):
        try:
            UUID(request.call_id)
        except ValueError as error:
            raise HTTPException(400) from error
        if (
            not request.owner
            or not request.speech.HasField("transcription")
            or not request.speech.synthesis.voices
        ):
            raise HTTPException(400)
        async with self.lock:
            existing = self.active.get(request.call_id)
            if existing and existing.owner != request.owner:
                raise HTTPException(403)
            if existing and existing.call.closed.is_set():
                raise HTTPException(409)
            if not existing:
                if self.closing or len(self.active) >= self.configuration.capacity:
                    raise HTTPException(429)
                rooms = await self.livekit.room.list_rooms(
                    api.ListRoomsRequest(names=[request.call_id])
                )
                if rooms.rooms:
                    metadata = json.loads(rooms.rooms[0].metadata or "{}")
                    if metadata.get("owner") != request.owner:
                        raise HTTPException(403)
                    await self.livekit.room.delete_room(api.DeleteRoomRequest(room=request.call_id))
                await self.livekit.room.create_room(
                    api.CreateRoomRequest(
                        name=request.call_id,
                        max_participants=2,
                        empty_timeout=30,
                        departure_timeout=10,
                        metadata=json.dumps({"owner": request.owner}),
                    )
                )
                call = Call(request, self.vad)
                try:
                    async with asyncio.timeout(12):
                        await call.start(
                            self.configuration.url, self.token(request.call_id, "assistant")
                        )
                except Exception:
                    await call.close()
                    await self.livekit.room.delete_room(api.DeleteRoomRequest(room=request.call_id))
                    raise
                task = asyncio.create_task(self._run(request.call_id, call))
                self.active[request.call_id] = Session(request.owner, call, task)
        return VoiceCallConnection(
            call_id=request.call_id,
            url=self.configuration.public_url,
            token=self.token(request.call_id, "caller"),
            synthesis_languages=[voice.language_code for voice in request.speech.synthesis.voices],
        )

    async def _run(self, call_id: str, call: Call):
        joined = asyncio.create_task(call.joined.wait())
        closed = asyncio.create_task(call.closed.wait())
        try:
            done, _ = await asyncio.wait(
                [joined, closed], timeout=45, return_when=asyncio.FIRST_COMPLETED
            )
            if not done or closed in done:
                return
            async with asyncio.timeout(1800):
                await call.closed.wait()
        except (TimeoutError, asyncio.CancelledError):
            pass
        finally:
            joined.cancel()
            closed.cancel()
            await asyncio.gather(joined, closed, return_exceptions=True)
            await call.close()
            with suppress(Exception):
                await self.livekit.room.delete_room(api.DeleteRoomRequest(room=call_id))
            async with self.lock:
                if self.active.get(call_id) and self.active[call_id].call is call:
                    self.active.pop(call_id)

    async def end(self, request: EndSessionRequest):
        async with self.lock:
            session = self.active.get(request.call_id)
            if session:
                if session.owner != request.owner:
                    raise HTTPException(403)
                session.call.closed.set()
            else:
                rooms = await self.livekit.room.list_rooms(
                    api.ListRoomsRequest(names=[request.call_id])
                )
                if rooms.rooms:
                    if json.loads(rooms.rooms[0].metadata or "{}").get("owner") != request.owner:
                        raise HTTPException(403)
                    await self.livekit.room.delete_room(api.DeleteRoomRequest(room=request.call_id))
        if session:
            await session.task

    async def close(self):
        self.closing = True
        sessions = list(self.active.values())
        for session in sessions:
            session.call.closed.set()
        await asyncio.gather(*(session.task for session in sessions), return_exceptions=True)
        await self.livekit.aclose()
