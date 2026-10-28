import asyncio

import pytest
from agentos.console.v1.speech_pb2 import SpeechSynthesis
from agentos_voice.synthesis import ConfiguredTTS
from agentos_voice.transcription import WhisperLiveKitSTT
from aiohttp import web
from livekit import rtc
from livekit.agents import stt


async def test_transcription_drains_native_snapshots_and_opens_the_next_turn(serve, tmp_path):
    token = tmp_path / "token"
    token.write_text("first-worker-token")
    connections = []

    async def listen(request):
        assert request.headers["Authorization"] == f"Bearer {token.read_text()}"
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

    url = await serve("/speech/transcription/asr", listen)
    provider = WhisperLiveKitSTT(url + "/speech/transcription/v1", str(token), "zh")
    stream = provider.stream()
    try:
        for index in range(2):
            token.write_text(f"worker-token-{index}")
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


async def test_pcm_audio_arrives_before_synthesis_finishes_and_keeps_its_first_sample(
    serve, tmp_path
):
    token = tmp_path / "token"
    token.write_text("worker-token")
    release = asyncio.Event()
    first = (-12345).to_bytes(2, "little", signed=True) + b"\0" * 2204

    async def synthesize(request):
        assert request.headers["Authorization"] == "Bearer worker-token"
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
    provider = ConfiguredTTS(settings, str(token), "zh")
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


async def test_each_synthesis_keeps_the_answer_language_independently_of_asr_language(tmp_path):
    token = tmp_path / "token"
    token.write_text("worker-token")
    settings = SpeechSynthesis(protocol=SpeechSynthesis.PROTOCOL_NEMO)
    settings.endpoint.base_url = "http://speech.test/v1"
    for language in ["zh", "en", "ar"]:
        settings.voices.add(model="magpie", voice=language, language_code=language)
    provider = ConfiguredTTS(settings, str(token), "en")
    streams = []
    try:
        for language in ["zh", "en", "ar"]:
            provider.select_language(language)
            streams.append(provider.synthesize("test"))
        assert [stream.voice.language_code for stream in streams] == ["zh", "en", "ar"]
    finally:
        await asyncio.gather(*(stream.aclose() for stream in streams))
        await provider.aclose()


async def test_deepgram_reloads_workload_token_for_each_connection(serve, tmp_path):
    from agentos.console.v1.speech_pb2 import SpeechTranscription
    from agentos_voice.transcription import transcriber

    token = tmp_path / "token"
    seen = []

    async def listen(request):
        seen.append(request.headers["Authorization"])
        assert request.query["model"] == "nova-3"
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        await socket.receive()
        await socket.send_json(
            {
                "type": "Results",
                "metadata": {"request_id": "test"},
                "channel_index": [0, 1],
                "duration": 1,
                "start": 0,
                "is_final": True,
                "speech_final": True,
                "channel": {
                    "alternatives": [
                        {
                            "transcript": "hello",
                            "confidence": 1,
                            "words": [{"word": "hello", "start": 0, "end": 1, "confidence": 1}],
                        }
                    ]
                },
            }
        )
        async for message in socket:
            if message.type.name == "CLOSE":
                break
        return socket

    url = await serve("/speech/transcription/v1/listen", listen)
    settings = SpeechTranscription(model="nova-3")
    settings.endpoint.base_url = url + "/speech/transcription/v1"
    provider = transcriber(settings, str(token), "en")
    try:
        for value in ["first", "second"]:
            token.write_text(value)
            stream = provider.stream()
            try:
                stream.push_frame(rtc.AudioFrame(b"\0" * 3200, 16000, 1, 1600))
                async with asyncio.timeout(3):
                    async for event in stream:
                        if event.type == stt.SpeechEventType.FINAL_TRANSCRIPT:
                            assert event.alternatives[0].text == "hello"
                            break
            finally:
                await stream.aclose()
        assert seen == ["Bearer first", "Bearer second"]
    finally:
        await provider.aclose()


async def test_gateway_credentials_stay_on_configured_origin(serve, tmp_path):
    from agentos_voice.gateway import gateway_session
    from aiohttp import ClientConnectionError

    token = tmp_path / "token"
    token.write_text("worker-token")
    leaked = []

    async def other(request):
        leaked.append(request.headers.get("Authorization"))
        return web.Response()

    target = await serve("/target", other)

    async def redirect(request):
        raise web.HTTPFound(target + "/target")

    origin = await serve("/redirect", redirect)
    async with gateway_session(str(token), origin) as client:
        with pytest.raises(ClientConnectionError, match="changed origin"):
            await client.get(origin + "/redirect")
    assert leaked == []


async def test_synthesis_reloads_workload_token_between_requests(serve, tmp_path):
    token = tmp_path / "token"
    seen = []

    async def synthesize(request):
        seen.append(request.headers["Authorization"])
        return web.Response(body=b"\0" * 4412, content_type="audio/pcm")

    url = await serve("/speech/synthesis/audio/speech", synthesize)
    settings = SpeechSynthesis(protocol=SpeechSynthesis.PROTOCOL_NEMO)
    settings.endpoint.base_url = url + "/speech/synthesis"
    settings.voices.add(model="tts", voice="default", language_code="en")
    provider = ConfiguredTTS(settings, str(token), "en")
    try:
        for value in ["first", "second"]:
            token.write_text(value)
            stream = provider.synthesize("hello")
            try:
                async for _ in stream:
                    pass
            finally:
                await stream.aclose()
        assert seen == ["Bearer first", "Bearer second"]
    finally:
        await provider.aclose()
