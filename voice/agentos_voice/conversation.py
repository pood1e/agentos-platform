"""AgentOS conversation as the call's language model.

Each user turn becomes a message in the session's conversation; the final answer is spoken.
Interruptions cancel the generation, which cancels the turn's task before the next turn starts.
"""

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable

from agentos.voice.v1.voice_pb2 import SendVoiceTurnResponse, VoiceEvent
from livekit.agents import llm
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS

from agentos_voice.platform import Platform, PlatformError
from agentos_voice.synthesis import ConfiguredTTS

logger = logging.getLogger(__name__)


class Conversation(llm.LLM):
    def __init__(
        self,
        platform: Platform,
        session_id: str,
        tts: ConfiguredTTS,
        publish: Callable[[VoiceEvent], Awaitable[None]],
    ):
        super().__init__()
        self.platform = platform
        self.session_id = session_id
        self.tts = tts
        self.publish = publish
        self.context_id = ""
        self.cancelling: asyncio.Task | None = None

    def chat(self, *, chat_ctx, tools=None, conn_options=DEFAULT_API_CONNECT_OPTIONS, **_):
        return Turn(self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options)

    async def cancel(self, sending: asyncio.Future[SendVoiceTurnResponse]):
        try:
            sent = await sending
            await self.platform.cancel_turn(self.session_id, sent.task_id)
        except PlatformError as error:
            logger.warning("Voice turn cancellation failed: %s", error.code)


class Turn(llm.LLMStream):
    def __init__(self, conversation: Conversation, **options):
        super().__init__(conversation, **options)
        self.conversation = conversation
        self.message_id = str(uuid.uuid4())

    async def _run(self):
        conversation = self.conversation
        if conversation.cancelling:
            await asyncio.shield(conversation.cancelling)
        message = next(
            (
                item
                for item in reversed(self._chat_ctx.items)
                if item.type == "message" and item.role == "user"
            ),
            None,
        )
        text = (message.text_content or "").strip()[:8000] if message else ""
        if not text:
            return
        # The send finishes even when the turn is interrupted, so its task can be cancelled.
        sending = asyncio.ensure_future(
            conversation.platform.send_turn(conversation.session_id, self.message_id, text)
        )
        try:
            sent = await asyncio.shield(sending)
            if sent.context_id != conversation.context_id:
                conversation.context_id = sent.context_id
                await conversation.publish(VoiceEvent(context_id=sent.context_id))
            while not (
                result := await conversation.platform.answer(conversation.session_id, sent.task_id)
            ).done:
                pass
        except asyncio.CancelledError:
            conversation.cancelling = asyncio.create_task(conversation.cancel(sending))
            raise
        except PlatformError as error:
            await conversation.publish(VoiceEvent(error=error.reason or "speech.callFailed"))
            return
        if result.HasField("answer"):
            conversation.tts.select_language(result.answer.language_code)
            self._event_ch.send_nowait(
                llm.ChatChunk(
                    id=self.message_id,
                    delta=llm.ChoiceDelta(role="assistant", content=result.answer.text),
                )
            )
