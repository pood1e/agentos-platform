import { Role } from "../../../gen/a2a_pb.js";
import type { ChatMessage, Conversation } from "../../../gen/agentos/console/v1/conversation_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import type { VoiceTurn } from "../../../gen/agentos/voice/v1/worker_pb.js";
import { speechText } from "../speech/text.js";

export interface VoiceChat {
  messages: readonly ChatMessage[];
  conversation?: Pick<Conversation, "state">;
  outgoing?: { id: string; contextId: string };
  busy: boolean;
  blocked: boolean;
  submit(text: string, messageId?: string): Promise<boolean>;
  cancel(taskId?: string): Promise<void>;
}

type Turn = {
  id: string;
  text: string;
  messageId: string;
  accepted: boolean;
  failed: boolean;
  interrupted: boolean;
  stopping: boolean;
};

/** Voice uses the same send/watch path as typed messages, with one foreground turn at a time. */
export class VoiceChatBridge {
  private queue: Turn[] = [];
  private current?: Turn;
  private seen = new Set<string>();
  private submitted = new Set<string>();
  private closed = false;
  private chat?: VoiceChat;

  constructor(
    private reply: (turnId: string, text: string) => void,
    private changed: (queued: number, failed: boolean) => void,
    private error: (key: string) => void,
  ) {}

  add(turn: VoiceTurn) {
    if (this.closed || this.seen.has(turn.id) || !turn.text.trim()) return;
    if (turn.text.length > 8000 || this.queue.length >= 8) {
      this.error("speech.callQueueFull");
      return;
    }
    this.seen.add(turn.id);
    this.queue.push({
      ...turn,
      messageId: crypto.randomUUID(),
      accepted: false,
      failed: false,
      interrupted: false,
      stopping: false,
    });
    this.notify();
    this.pump();
  }

  ownsMessage(messageId: string) {
    return this.submitted.has(messageId);
  }

  update(chat: VoiceChat) {
    if (this.closed) return;
    this.chat = chat;
    const turn = this.current;
    if (turn?.accepted) {
      const user = chat.messages.find((message) => message.id === turn.messageId);
      if (turn.interrupted) {
        if (user?.taskId && !turn.stopping && !turn.failed)
          void this.cancel(turn, chat, user.taskId);
        return;
      }
      const answer = user?.taskId
        ? chat.messages.find(
            (message) => message.role === Role.AGENT && message.taskId === user.taskId,
          )
        : undefined;
      const final = answer?.parts.filter((part) => part.content.case === "text");
      if (final?.length) {
        const text = speechText(final.map((part) => part.content.value).join("\n\n"));
        if (text && text.length <= 8000) this.reply(turn.id, text);
        else if (text) this.error("speech.tooLarge");
        this.current = undefined;
        this.notify();
      } else if (
        user &&
        !chat.busy &&
        [ActivityState.FAILED, ActivityState.REJECTED, ActivityState.CANCELED].includes(
          chat.conversation?.state ?? ActivityState.UNSPECIFIED,
        )
      ) {
        this.current = undefined;
        this.notify();
      }
    }
    this.pump();
  }

  retry() {
    if (!this.current?.failed) return;
    this.current.failed = false;
    if (this.current.interrupted && this.current.accepted) {
      if (this.chat) this.update(this.chat);
      return;
    }
    this.queue.unshift(this.current);
    this.current = undefined;
    this.notify();
    this.pump();
  }

  interrupt() {
    if (this.closed || !this.current) return;
    this.current.interrupted = true;
    if (this.chat) this.update(this.chat);
  }

  private async cancel(turn: Turn, chat: VoiceChat, taskId: string) {
    turn.stopping = true;
    try {
      await chat.cancel(taskId);
      if (this.closed || this.current !== turn) return;
      this.current = undefined;
      this.notify();
      this.pump();
    } catch {
      if (this.closed || this.current !== turn) return;
      turn.stopping = false;
      turn.failed = true;
      this.notify();
      this.error("task.cancelFailed");
    }
  }

  close() {
    this.closed = true;
    return [
      ...(this.current && !this.current.accepted ? [this.current.text] : []),
      ...this.queue.map((turn) => turn.text),
    ].join("\n");
  }

  private notify() {
    this.changed(this.queue.length + (this.current ? 1 : 0), this.current?.failed ?? false);
  }

  private pump() {
    const chat = this.chat;
    if (this.closed || this.current || chat?.blocked !== false || !this.queue.length) return;
    const turn = this.queue.shift();
    if (!turn) return;
    this.current = turn;
    this.submitted.add(turn.messageId);
    this.notify();
    void chat.submit(turn.text, turn.messageId).then((accepted) => {
      if (this.closed) return;
      turn.accepted = accepted;
      turn.failed = !accepted;
      this.notify();
      if (accepted && this.chat) this.update(this.chat);
    });
  }
}
