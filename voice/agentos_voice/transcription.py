"""Configured transcription; WhisperLiveKit's native snapshot protocol as a LiveKit STT."""

import asyncio
import json
import struct
import weakref
from urllib.parse import urlencode, urlsplit, urlunsplit

import aiohttp
from agentos.console.v1.speech_pb2 import SpeechTranscription
from livekit.agents import APIConnectionError, stt
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from livekit.plugins import deepgram

from agentos_voice.gateway import gateway_session


def transcriber(settings: SpeechTranscription, token_file: str, language: str) -> stt.STT:
    if settings.protocol == SpeechTranscription.PROTOCOL_WHISPERLIVEKIT:
        return WhisperLiveKitSTT(settings.endpoint.base_url, token_file, language)
    return GatewayDeepgramSTT(
        token_file=token_file,
        base_url=settings.endpoint.base_url.rstrip("/") + "/listen",
        model=settings.model,
        language=language or "multi",
    )


class GatewayDeepgramSTT(deepgram.STT):
    def __init__(self, token_file: str, **kwargs):
        self.http = gateway_session(token_file, kwargs["base_url"])
        super().__init__(api_key="gateway", http_session=self.http, **kwargs)

    async def aclose(self):
        try:
            await super().aclose()
        finally:
            await self.http.close()


class WhisperLiveKitSTT(stt.STT):
    def __init__(self, endpoint: str, token_file: str, language: str):
        super().__init__(
            capabilities=stt.STTCapabilities(
                streaming=True, interim_results=True, offline_recognize=False
            )
        )
        parts = urlsplit(endpoint)
        self.url = urlunsplit(
            (
                "wss" if parts.scheme == "https" else "ws",
                parts.netloc,
                parts.path.removesuffix("/v1").rstrip("/") + "/asr",
                urlencode({"language": language}) if language else "",
                "",
            )
        )
        self.token_file = token_file
        self.endpoint = endpoint
        self.language = language
        self.streams: weakref.WeakSet[WhisperStream] = weakref.WeakSet()

    async def _recognize_impl(self, buffer, *, language, conn_options):
        raise NotImplementedError("This provider uses native WebSocket transcription")

    def stream(self, *, language=None, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        stream = WhisperStream(self, conn_options)
        self.streams.add(stream)
        return stream

    def flush(self):
        for stream in self.streams:
            stream.end_turn()

    async def aclose(self):
        await asyncio.gather(*(stream.aclose() for stream in self.streams))


class WhisperStream(stt.RecognizeStream):
    def __init__(self, provider: WhisperLiveKitSTT, conn_options):
        self.provider = provider
        super().__init__(stt=provider, conn_options=conn_options, sample_rate=16000)

    def end_turn(self):
        if not self._input_ch.closed:
            self.flush()

    async def _run(self):
        try:
            more = True
            async with gateway_session(self.provider.token_file, self.provider.endpoint) as client:
                while more:
                    async with client.ws_connect(
                        self.provider.url,
                        max_msg_size=1024 * 1024,
                        heartbeat=20,
                        timeout=aiohttp.ClientWSTimeout(ws_close=10),
                    ) as socket:
                        # FFmpeg accepts a WAV header with an unspecified final size.
                        await socket.send_bytes(
                            struct.pack(
                                "<4sI4s4sIHHIIHH4sI",
                                b"RIFF",
                                0x7FFFFFFF,
                                b"WAVE",
                                b"fmt ",
                                16,
                                1,
                                1,
                                16000,
                                32000,
                                2,
                                16,
                                b"data",
                                0x7FFFFFFF,
                            )
                        )
                        async with asyncio.TaskGroup() as tasks:
                            receiver = tasks.create_task(self._receive(socket))
                            more = await self._send(socket)
                            async with asyncio.timeout(15):
                                await receiver
        except asyncio.CancelledError:
            raise
        except Exception as error:
            raise APIConnectionError("Transcription provider unavailable") from error

    async def _send(self, socket):
        async for frame in self._input_ch:
            if isinstance(frame, self._FlushSentinel):
                await socket.send_bytes(b"")
                return True
            await socket.send_bytes(frame.data.tobytes())
        await socket.send_bytes(b"")
        return False

    async def _receive(self, socket):
        draft = ""
        async for data in socket:
            if data.type != aiohttp.WSMsgType.TEXT:
                raise APIConnectionError("Invalid transcription response")
            message = json.loads(data.data)
            if message.get("type") == "error" or message.get("status") == "error":
                raise APIConnectionError("Transcription provider rejected the audio")
            if message.get("type") == "ready_to_stop":
                if draft:
                    self._event_ch.send_nowait(
                        stt.SpeechEvent(
                            type=stt.SpeechEventType.FINAL_TRANSCRIPT,
                            alternatives=[
                                stt.SpeechData(language=self.provider.language, text=draft)
                            ],
                        )
                    )
                self._event_ch.send_nowait(stt.SpeechEvent(type=stt.SpeechEventType.END_OF_SPEECH))
                return
            if "lines" not in message:
                continue
            text = (
                "".join(
                    line.get("text", "") for line in message["lines"] if line.get("speaker") != -2
                )
                + message.get("buffer_diarization", "")
                + message.get("buffer_transcription", "")
            )
            if text and text != draft:
                if not draft:
                    self._event_ch.send_nowait(
                        stt.SpeechEvent(type=stt.SpeechEventType.START_OF_SPEECH)
                    )
                draft = text
                self._event_ch.send_nowait(
                    stt.SpeechEvent(
                        type=stt.SpeechEventType.INTERIM_TRANSCRIPT,
                        alternatives=[stt.SpeechData(language=self.provider.language, text=text)],
                    )
                )
        raise APIConnectionError("Transcription ended before its final result")
