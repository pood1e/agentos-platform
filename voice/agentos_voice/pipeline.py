"""LiveKit owns audio and turn boundaries; the authenticated browser submits chat messages."""

import asyncio
import logging
import uuid

from agentos.console.v1.speech_pb2 import SpeechTranscription
from agentos.voice.v1.worker_pb2 import StartSessionRequest, VoiceEvent, VoiceReply, VoiceTurn
from google.protobuf.json_format import MessageToJson, Parse, ParseError
from livekit import rtc
from livekit.agents import Agent, AgentSession, llm
from livekit.agents.voice import room_io
from livekit.plugins import deepgram, silero

from agentos_voice.synthesis import ConfiguredTTS
from agentos_voice.transcription import WhisperLiveKitSTT

TOPIC = "agentos.voice"
logger = logging.getLogger(__name__)


class AudioAgent(Agent):
    def __init__(self, room: rtc.Room):
        super().__init__(instructions="Audio transport for the AgentOS assistant.")
        self.room = room
        self.turn_id = ""
        self.replied = ""

    async def publish(self, event: VoiceEvent):
        await self.room.local_participant.publish_data(
            MessageToJson(event).encode(), topic=TOPIC, reliable=True
        )

    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage):
        if new_message.text_content and new_message.text_content.strip():
            self.turn_id = self.turn_id or str(uuid.uuid4())
            await self.publish(
                VoiceEvent(user_turn=VoiceTurn(id=self.turn_id, text=new_message.text_content))
            )


class Call:
    def __init__(self, request: StartSessionRequest, vad: silero.VAD):
        self.room = rtc.Room()
        configuration = request.speech.transcription
        self.stt = (
            WhisperLiveKitSTT(
                configuration.endpoint.base_url,
                request.transcription_credential,
                request.language_code,
            )
            if configuration.protocol == SpeechTranscription.PROTOCOL_WHISPERLIVEKIT
            else deepgram.STT(
                api_key=request.transcription_credential,
                base_url=configuration.endpoint.base_url.removesuffix("/v1"),
                model=configuration.model,
                language=request.language_code or "multi",
            )
        )
        self.tts = ConfiguredTTS(
            request.speech.synthesis, request.synthesis_credential, request.language_code
        )
        self.session = AgentSession(
            stt=self.stt,
            tts=self.tts,
            vad=vad,
            aec_warmup_duration=None,
            turn_handling={
                "turn_detection": "vad",
                "endpointing": {"min_delay": 0.5, "max_delay": 3.0},
                "interruption": {
                    "enabled": True,
                    "mode": "vad",
                    "min_duration": 0.2,
                    "resume_false_interruption": False,
                },
                "preemptive_generation": {"enabled": False},
            },
        )
        self.agent = AudioAgent(self.room)
        self.closed = asyncio.Event()
        self.joined = asyncio.Event()
        self.background: set[asyncio.Task] = set()

        @self.session.on("user_state_changed")
        def user_state(event):
            if event.new_state == "speaking":
                self.agent.turn_id = str(uuid.uuid4())
                self.spawn(self.agent.publish(VoiceEvent(input_started=self.agent.turn_id)))
            elif event.old_state == "speaking" and isinstance(self.stt, WhisperLiveKitSTT):
                self.stt.flush()

        @self.session.on("user_input_transcribed")
        def transcript(event):
            self.spawn(self.agent.publish(VoiceEvent(transcript=event.transcript)))

        @self.room.on("data_received")
        def reply(packet: rtc.DataPacket):
            if (
                packet.topic != TOPIC
                or not packet.participant
                or packet.participant.identity != "caller"
            ):
                return
            try:
                response = Parse(packet.data.decode(), VoiceReply())
            except (ValueError, UnicodeDecodeError, ParseError):
                return
            if response.turn_id != self.agent.turn_id or response.turn_id == self.agent.replied:
                return
            if not 0 < len(response.text) <= 8000:
                return
            self.agent.replied = response.turn_id
            self.tts.select_language(response.language_code)
            self.session.say(response.text, allow_interruptions=True, add_to_chat_ctx=False)

        @self.room.on("participant_disconnected")
        def disconnected(participant):
            if participant.identity == "caller":
                self.closed.set()

        @self.room.on("participant_connected")
        def connected(participant):
            if participant.identity == "caller":
                self.joined.set()

        @self.session.on("error")
        def failed(event):
            if not event.error.recoverable:
                logger.error("Voice session failed: %s", type(event.error).__name__)
                self.closed.set()

        @self.session.on("close")
        def session_closed(_event):
            self.closed.set()

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.background.add(task)
        task.add_done_callback(self.completed)

    def completed(self, task):
        self.background.discard(task)
        if not task.cancelled() and task.exception():
            logger.error("Voice event delivery failed: %s", type(task.exception()).__name__)
            self.closed.set()

    async def start(self, url: str, token: str):
        await self.room.connect(url, token)
        await self.session.start(
            agent=self.agent,
            room=self.room,
            room_options=room_io.RoomOptions(participant_identity="caller"),
        )

    async def close(self):
        self.closed.set()
        await self.session.aclose()
        for task in self.background:
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)
        await self.stt.aclose()
        await self.tts.aclose()
        await self.room.disconnect()
