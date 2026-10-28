"""LiveKit voice agent for AgentOS dictation, read-aloud and call sessions."""

import asyncio
import logging
import os

import aiohttp
from agentos.console.v1.speech_pb2 import VoiceMode
from agentos.voice.v1.voice_pb2 import GetVoiceSessionResponse, VoiceEvent
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobExecutorType,
    JobProcess,
    StopResponse,
)
from livekit.agents.voice import room_io
from livekit.plugins import silero

from agentos_voice.conversation import Conversation
from agentos_voice.platform import Platform, PlatformError
from agentos_voice.synthesis import ConfiguredTTS
from agentos_voice.transcription import WhisperLiveKitSTT, transcriber

logger = logging.getLogger(__name__)
capacity = int(os.environ.get("VOICE_CAPACITY", "4"))
server = AgentServer(
    job_executor_type=JobExecutorType.THREAD,
    num_idle_processes=1,
    load_fnc=lambda server: len(server.active_jobs) / capacity,
    load_threshold=(capacity - 0.5) / capacity,
)


def prewarm(proc: JobProcess):
    proc.userdata["vad"] = silero.VAD.load(min_speech_duration=0.2, min_silence_duration=0.8)


server.setup_fnc = prewarm

# The browser leaving closes the session; closing the session deletes the room.
room_options = {"close_on_disconnect": True, "delete_room_on_close": True, "text_input": False}


def flush(session: AgentSession):
    # WhisperLiveKit finalizes a transcript when its stream ends.
    if isinstance(provider := session.stt, WhisperLiveKitSTT):
        provider.flush()


def listen(session: AgentSession):
    @session.on("user_state_changed")
    def ended(event):
        if event.old_state == "speaking":
            flush(session)


class Voice:
    def __init__(self, ctx: JobContext, session: GetVoiceSessionResponse):
        self.ctx = ctx
        self.session = session
        self.tasks: set[asyncio.Task] = set()

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def publish(self, event: VoiceEvent):
        try:
            await self.ctx.room.local_participant.publish_data(
                event.SerializeToString(), reliable=True, topic="agentos.voice"
            )
        except Exception as error:
            logger.warning("Voice event delivery failed: %s", type(error).__name__)

    def transcriber(self):
        provider = transcriber(
            self.session.configuration.transcription,
            os.environ["AGENTOS_TOKEN_FILE"],
            self.session.language_code,
        )
        self.ctx.add_shutdown_callback(provider.aclose)
        return provider

    def synthesizer(self, language: str):
        provider = ConfiguredTTS(
            self.session.configuration.synthesis, os.environ["AGENTOS_TOKEN_FILE"], language
        )
        self.ctx.add_shutdown_callback(provider.aclose)
        return provider


async def dictate(voice: Voice):
    """Ends after 1.4 s of silence, 12 s without speech, 60 s in total or a muted microphone."""
    session = AgentSession(
        stt=voice.transcriber(),
        vad=voice.ctx.proc.userdata["vad"],
        turn_handling={
            "turn_detection": "vad",
            "endpointing": {"min_delay": 1.4, "max_delay": 1.4},
        },
        user_away_timeout=12,
    )
    listen(session)
    finished = asyncio.Event()

    async def finish(transcript: str):
        if finished.is_set():
            return
        finished.set()
        await voice.publish(VoiceEvent(transcript=transcript))
        # The browser leaves with the transcript; this only closes abandoned rooms.
        asyncio.get_running_loop().call_later(5, session.shutdown)

    async def commit():
        if finished.is_set():
            return
        session.input.set_audio_enabled(False)
        transcript = session.commit_user_turn(transcript_timeout=10, skip_reply=True)
        flush(session)
        await finish(await transcript)

    class Dictation(Agent):
        async def on_user_turn_completed(self, turn_ctx, new_message):
            await finish(new_message.text_content or "")
            raise StopResponse()

    @voice.ctx.room.on("track_muted")
    def muted(participant, publication):
        if (
            isinstance(participant, rtc.RemoteParticipant)
            and publication.source == rtc.TrackSource.SOURCE_MICROPHONE
        ):
            voice.spawn(commit())

    @session.on("user_state_changed")
    def away(event):
        if event.new_state == "away":
            voice.spawn(finish(""))

    await session.start(
        agent=Dictation(instructions="Transcribe the user's dictation."),
        room=voice.ctx.room,
        session_host=False,
        room_options=room_io.RoomOptions(audio_output=False, **room_options),
    )
    asyncio.get_running_loop().call_later(60, lambda: voice.spawn(commit()))


async def read_aloud(voice: Voice):
    speech = voice.session.speech
    session = AgentSession(tts=voice.synthesizer(speech.language_code))
    await session.start(
        agent=Agent(instructions="Read the answer aloud."),
        room=voice.ctx.room,
        session_host=False,
        room_options=room_io.RoomOptions(audio_input=False, text_output=False, **room_options),
    )
    handle = session.say(speech.text, allow_interruptions=False, add_to_chat_ctx=False)
    await handle.wait_for_playout()
    # Lets the browser's jitter buffer drain before the room closes.
    await asyncio.sleep(1)
    session.shutdown()


async def call(voice: Voice, platform: Platform):
    """Talking interrupts the answer and cancels its task; calls end after 30 minutes."""
    tts = voice.synthesizer(voice.session.language_code)
    session = AgentSession(
        stt=voice.transcriber(),
        tts=tts,
        vad=voice.ctx.proc.userdata["vad"],
        llm=Conversation(platform, tts, voice.publish),
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
    listen(session)
    await session.start(
        agent=Agent(instructions="Relay the call to the AgentOS conversation."),
        room=voice.ctx.room,
        session_host=False,
        room_options=room_io.RoomOptions(**room_options),
    )
    asyncio.get_running_loop().call_later(1800, session.shutdown)


@server.rtc_session(agent_name=os.environ["LIVEKIT_AGENT_NAME"])
async def entrypoint(ctx: JobContext):
    http = aiohttp.ClientSession()
    ctx.add_shutdown_callback(http.close)
    platform = Platform(
        os.environ["AGENTOS_API_URL"],
        os.environ["AGENTOS_TOKEN_FILE"],
        http,
        ctx.room.name,
        ctx.job.metadata,
    )
    try:
        voice = Voice(ctx, await platform.session())
    except PlatformError as error:
        logger.warning("Voice session unavailable: %s", error.code)
        await ctx.delete_room()
        return
    if voice.session.mode == VoiceMode.VOICE_MODE_DICTATION:
        await dictate(voice)
    elif voice.session.mode == VoiceMode.VOICE_MODE_READ_ALOUD:
        await read_aloud(voice)
    elif voice.session.mode == VoiceMode.VOICE_MODE_CALL:
        await call(voice, platform)
