import asyncio

import pytest
from agentos.console.v1.speech_pb2 import SpeechSynthesis
from agentos_voice.synthesis import ConfiguredTTS
from agentos_voice.transcription import WhisperLiveKitSTT
from aiohttp import web
from livekit import rtc
from livekit.agents import stt


@pytest.fixture
async def serve():
    runners = []

    async def start(path, handler):
        app = web.Application()
        app.router.add_route("*", path, handler)
        runner = web.AppRunner(app)
        await runner.setup()
        runners.append(runner)
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = runner.addresses[0][1]
        return f"http://127.0.0.1:{port}"

    yield start
    for runner in runners:
        await runner.cleanup()


async def test_transcription_drains_native_snapshots_and_opens_the_next_turn(serve):
    connections = []

    async def listen(request):
        assert request.headers["Authorization"] == "Bearer test-token"
        assert request.query["language"] == "zh"
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        header = await socket.receive_bytes()
        assert header[:4] == b"RIFF" and header[8:12] == b"WAVE"
        connections.append(True)
        async for message in socket:
            if message.data == b"":
                await socket.send_json({"lines": [{"text": "现在开始检查交换机。"}]})
                await socket.send_json({"type": "ready_to_stop"})
                break
            await socket.send_json({"lines": [], "buffer_transcription": "现在开始"})
        return socket

    url = await serve("/asr", listen)
    provider = WhisperLiveKitSTT(url + "/v1", "test-token", "zh")
    stream = provider.stream()
    try:
        for _ in range(2):
            stream.push_frame(rtc.AudioFrame(b"\0" * 3200, 16000, 1, 1600))
            provider.flush()
            async with asyncio.timeout(3):
                async for event in stream:
                    if event.type == stt.SpeechEventType.FINAL_TRANSCRIPT:
                        assert event.alternatives[0].text == "现在开始检查交换机。"
                        break
        assert len(connections) == 2
    finally:
        await provider.aclose()


async def test_pcm_audio_arrives_before_synthesis_finishes_and_keeps_its_first_sample(serve):
    release = asyncio.Event()
    first = (-12345).to_bytes(2, "little", signed=True) + b"\0" * 2204

    async def synthesize(request):
        body = await request.json()
        assert body["input"] == "现在开始。"
        assert body["language"] == "zh" and body["sample_rate"] == 22050
        assert body["response_format"] == "pcm"
        response = web.StreamResponse(headers={"Content-Type": "audio/pcm;rate=22050;channels=1"})
        await response.prepare(request)
        await response.write(first)
        await release.wait()
        await response.write(b"\0" * 2206)
        return response

    url = await serve("/v1/audio/speech", synthesize)
    settings = SpeechSynthesis(protocol=SpeechSynthesis.PROTOCOL_NEMO)
    settings.endpoint.base_url = url + "/v1"
    settings.voices.add(model="magpie", voice="0", language_code="zh")
    provider = ConfiguredTTS(settings, "test-token", "zh")
    stream = provider.synthesize("现在开始。")
    try:
        async with asyncio.timeout(3):
            first_frame = await anext(stream)
        assert first_frame.frame.data.tobytes()[:2] == first[:2]
        assert not release.is_set()
        release.set()
        frames = [first_frame, *[frame async for frame in stream]]
        assert sum(frame.frame.samples_per_channel for frame in frames) == 2206
    finally:
        release.set()
        await stream.aclose()
        await provider.aclose()


async def test_each_synthesis_keeps_the_answer_language_independently_of_asr_language():
    settings = SpeechSynthesis(protocol=SpeechSynthesis.PROTOCOL_NEMO)
    settings.endpoint.base_url = "http://speech.test/v1"
    for language in ["zh", "en", "ar"]:
        settings.voices.add(model="magpie", voice=language, language_code=language)
    provider = ConfiguredTTS(settings, "test-token", "en")
    streams = []
    try:
        for language in ["zh", "en", "ar"]:
            provider.select_language(language)
            streams.append(provider.synthesize("test"))
        assert [stream.voice.language_code for stream in streams] == ["zh", "en", "ar"]
    finally:
        await asyncio.gather(*(stream.aclose() for stream in streams))
        await provider.aclose()
