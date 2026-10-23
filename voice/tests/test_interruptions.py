import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from agentos.console.v1.speech_pb2 import SpeechTranscription
from agentos.voice.v1.worker_pb2 import StartSessionRequest, VoiceReply
from agentos_voice.pipeline import TOPIC, Call
from google.protobuf.json_format import MessageToJson


async def test_new_speech_interrupts_playout_and_rejects_the_previous_turns_late_reply(monkeypatch):
    request = StartSessionRequest(language_code="zh")
    request.speech.transcription.protocol = SpeechTranscription.PROTOCOL_WHISPERLIVEKIT
    request.speech.transcription.endpoint.base_url = "http://asr.test/v1"
    request.speech.synthesis.endpoint.base_url = "http://tts.test/v1"
    request.speech.synthesis.voices.add(model="magpie", voice="0", language_code="zh")
    call = Call(request, None)
    interrupt = Mock()
    say = Mock()
    publish = AsyncMock()
    monkeypatch.setattr(call.session, "interrupt", interrupt)
    monkeypatch.setattr(call.session, "say", say)
    monkeypatch.setattr(call.agent, "publish", publish)
    monkeypatch.setattr(call.room, "disconnect", AsyncMock())

    def speak():
        call.session.emit(
            "user_state_changed", SimpleNamespace(old_state="listening", new_state="speaking")
        )

    def reply(turn_id, text):
        call.room.emit(
            "data_received",
            SimpleNamespace(
                topic=TOPIC,
                participant=SimpleNamespace(identity="caller"),
                data=MessageToJson(
                    VoiceReply(turn_id=turn_id, text=text, language_code="zh")
                ).encode(),
            ),
        )

    try:
        speak()
        first = call.agent.turn_id
        reply(first, "原来的答复")
        speak()
        second = call.agent.turn_id
        assert second != first
        assert interrupt.call_count == 2
        reply(first, "延迟到达的旧答复")
        assert say.call_count == 1
        reply(second, "新的答复")
        say.assert_called_with("新的答复", allow_interruptions=True, add_to_chat_ctx=False)
        await asyncio.gather(*call.background)
        assert [event.args[0].input_started for event in publish.call_args_list] == [first, second]
    finally:
        await call.close()
