"""Configured OpenAI-compatible PCM providers with native LiveKit audio emission."""

import uuid

from agentos.console.v1.speech_pb2 import SpeechSynthesis
from livekit.agents import APIConnectionError, tts
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from openai import AsyncOpenAI

from agentos_voice.gateway import token_source


class ConfiguredTTS(tts.TTS):
    def __init__(self, settings: SpeechSynthesis, token_file: str, language: str):
        self.nemo = settings.protocol == SpeechSynthesis.PROTOCOL_NEMO
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=22050 if self.nemo else 24000,
            num_channels=1,
        )
        self.client = AsyncOpenAI(
            base_url=settings.endpoint.base_url,
            api_key=token_source(token_file),
            max_retries=0,
            timeout=60,
        )
        self.voices = list(settings.voices)
        self.language = language

    def select_language(self, language: str):
        self.language = language

    def synthesize(self, text: str, *, conn_options=DEFAULT_API_CONNECT_OPTIONS):
        voice = next(
            (voice for voice in self.voices if voice.language_code == self.language), self.voices[0]
        )
        return SynthesisStream(self, text, conn_options, voice)

    async def aclose(self):
        await self.client.close()


class SynthesisStream(tts.ChunkedStream):
    def __init__(self, provider: ConfiguredTTS, text: str, conn_options, voice):
        self.provider = provider
        self.voice = voice
        super().__init__(tts=provider, input_text=text, conn_options=conn_options)

    async def _run(self, output_emitter: tts.AudioEmitter):
        provider = self.provider
        voice = self.voice
        extra = None
        if provider.nemo:
            extra = {
                "language": "ar-MSA" if voice.language_code == "ar" else voice.language_code,
                "sample_rate": provider.sample_rate,
            }
        try:
            async with provider.client.audio.speech.with_streaming_response.create(
                model=voice.model,
                voice=voice.voice,
                input=self.input_text,
                response_format="pcm",
                extra_body=extra,
            ) as response:
                content_type = response.headers.get("content-type", "").split(";")[0]
                if content_type not in ("audio/pcm", "application/octet-stream"):
                    raise APIConnectionError("Speech provider did not return PCM")
                output_emitter.initialize(
                    request_id=str(uuid.uuid4()),
                    sample_rate=provider.sample_rate,
                    num_channels=1,
                    mime_type="audio/pcm",
                    frame_size_ms=20,
                )
                size = 0
                async for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > 16 * 1024 * 1024:
                        raise APIConnectionError("Speech response is too large")
                    output_emitter.push(chunk)
                if not size or size % 2:
                    raise APIConnectionError("Speech response is incomplete")
        except Exception as error:
            raise APIConnectionError("Speech synthesis unavailable") from error
