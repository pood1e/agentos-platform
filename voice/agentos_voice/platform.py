"""AgentOS voice API over Connect unary JSON, signed with the worker's service account token."""

import asyncio
import base64
import json
from pathlib import Path

import aiohttp
from agentos.voice.v1 import voice_pb2
from google.protobuf.json_format import MessageToJson, Parse, ParseError
from google.protobuf.message import Message
from google.rpc.error_details_pb2 import ErrorInfo

RETRYABLE = {"unavailable", "deadline_exceeded", "unknown"}
# Answers wait up to 20 s on the platform; cancellation waits for the task tree to settle.
DEADLINES = {"GetVoiceAnswer": 30, "CancelVoiceTurn": 40}


class PlatformError(Exception):
    def __init__(self, code: str, reason: str = ""):
        super().__init__(code)
        self.code = code
        # Localization key of the failure, when the platform reported one.
        self.reason = reason


def failure(status: int, body: bytes) -> PlatformError:
    try:
        value = json.loads(body)
        for detail in value.get("details", []):
            if detail.get("type") == "google.rpc.ErrorInfo":
                data = detail["value"]
                info = ErrorInfo.FromString(base64.b64decode(data + "=" * (-len(data) % 4)))
                return PlatformError(value.get("code", "unknown"), info.reason)
        return PlatformError(value.get("code", "unknown"))
    except (ValueError, KeyError, TypeError, AttributeError):
        return PlatformError("unavailable" if status >= 500 else "unknown")


class Platform:
    def __init__(
        self,
        url: str,
        token_file: str,
        http: aiohttp.ClientSession,
        session_id: str,
        session_token: str,
    ):
        self.url = url.rstrip("/")
        self.token_file = Path(token_file)
        self.http = http
        self.session_id = session_id
        self.session_token = session_token
        self.started = False

    async def call(self, method: str, request: Message, response: Message):
        # Every method is idempotent, so transport failures are retried.
        for attempt in range(3):
            try:
                async with asyncio.timeout(DEADLINES.get(method, 15)):
                    return await self.attempt(method, request, response)
            except (aiohttp.ClientError, TimeoutError) as error:
                if attempt == 2:
                    raise PlatformError("unavailable") from error
            except PlatformError as error:
                if attempt == 2 or error.code not in RETRYABLE:
                    raise
            await asyncio.sleep(0.5 * 2**attempt)
        raise PlatformError("unavailable")

    async def attempt(self, method: str, request: Message, response: Message):
        token = (await asyncio.to_thread(self.token_file.read_text)).strip()
        async with self.http.post(
            f"{self.url}/agentos.voice.v1.VoiceService/{method}",
            data=MessageToJson(request),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            allow_redirects=False,
        ) as reply:
            body = await reply.read()
            if reply.status != 200:
                raise failure(reply.status, body)
        try:
            return Parse(body, response, ignore_unknown_fields=True)
        except ParseError as error:
            raise PlatformError("unknown") from error

    def session(self):
        return self.call(
            "GetVoiceSession",
            voice_pb2.GetVoiceSessionRequest(
                session_id=self.session_id, session_token=self.session_token
            ),
            voice_pb2.GetVoiceSessionResponse(),
        )

    async def send_turn(self, message_id: str, text: str):
        response = await self.call(
            "SendVoiceTurn",
            voice_pb2.SendVoiceTurnRequest(
                session_id=self.session_id,
                session_token=self.session_token,
                message_id=message_id if self.started else self.session_id,
                text=text,
            ),
            voice_pb2.SendVoiceTurnResponse(),
        )
        self.session_token = response.session_token
        self.started = True
        return response

    def answer(self, task_id: str):
        return self.call(
            "GetVoiceAnswer",
            voice_pb2.GetVoiceAnswerRequest(
                session_id=self.session_id, session_token=self.session_token, task_id=task_id
            ),
            voice_pb2.GetVoiceAnswerResponse(),
        )

    def cancel_turn(self, task_id: str):
        return self.call(
            "CancelVoiceTurn",
            voice_pb2.CancelVoiceTurnRequest(
                session_id=self.session_id, session_token=self.session_token, task_id=task_id
            ),
            voice_pb2.CancelVoiceTurnResponse(),
        )
