import asyncio
from unittest.mock import AsyncMock, Mock

from agentos.voice.v1.voice_pb2 import (
    GetVoiceAnswerResponse,
    SendVoiceTurnResponse,
    Speech,
    VoiceEvent,
)
from agentos_voice.conversation import Conversation
from agentos_voice.platform import PlatformError
from livekit.agents import Agent, AgentSession, llm


def said(text):
    context = llm.ChatContext()
    context.add_message(role="user", content=text)
    return context


class Platform:
    def __init__(self):
        self.calls = []
        self.accepted = asyncio.Event()

    async def send_turn(self, session_id, message_id, text):
        self.calls.append(("send", text))
        if text == "first":
            await self.accepted.wait()
        return SendVoiceTurnResponse(context_id="conversation", task_id=f"task-{text}")

    async def answer(self, session_id, task_id):
        if task_id == "task-first":
            await asyncio.Event().wait()
        return GetVoiceAnswerResponse(done=True, answer=Speech(text="已完成", language_code="zh"))

    async def cancel_turn(self, session_id, task_id):
        self.calls.append(("cancel", task_id))


async def test_an_interrupted_turn_cancels_its_task_before_the_next_turn_is_sent():
    platform, tts, publish = Platform(), Mock(), AsyncMock()
    conversation = Conversation(platform, "session", tts, publish)
    first = conversation.chat(chat_ctx=said("first"))
    await asyncio.sleep(0.01)
    await first.aclose()
    second = conversation.chat(chat_ctx=said("second"))
    await asyncio.sleep(0.01)
    assert platform.calls == [("send", "first")]
    platform.accepted.set()
    async with asyncio.timeout(3):
        chunks = [chunk async for chunk in second]
    assert platform.calls == [("send", "first"), ("cancel", "task-first"), ("send", "second")]
    assert [chunk.delta.content for chunk in chunks] == ["已完成"]
    tts.select_language.assert_called_once_with("zh")
    publish.assert_awaited_once_with(VoiceEvent(context_id="conversation"))


async def test_a_rejected_turn_reports_its_reason_and_stays_silent():
    platform, publish = Mock(), AsyncMock()
    platform.send_turn = AsyncMock(side_effect=PlatformError("aborted", "chat.busy"))
    turn = Conversation(platform, "session", Mock(), publish).chat(chat_ctx=said("巡检"))
    async with asyncio.timeout(3):
        assert [chunk async for chunk in turn] == []
    publish.assert_awaited_once_with(VoiceEvent(error="chat.busy"))


async def test_the_agent_session_answers_each_turn_through_the_conversation():
    platform = Platform()
    async with AgentSession(llm=Conversation(platform, "session", Mock(), AsyncMock())) as session:
        await session.start(Agent(instructions="Relay the call."))
        await session.run(user_input="second")
        answers = [
            item.text_content
            for item in session.history.items
            if getattr(item, "role", "") == "assistant"
        ]
    assert answers == ["已完成"]
    assert platform.calls == [("send", "second")]
