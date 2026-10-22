import { Role } from "../../../../gen/a2a_pb.js";
import { ActivityState } from "../../../../gen/agentos/execution/v1/state_pb.js";
import type { VoiceTurn } from "../../../../gen/agentos/voice/v1/worker_pb.js";
import { speechText } from "../speech/text.js";
import type { Chat } from "../use-chat.js";

type Turn = { id: string; text: string; messageId: string; accepted: boolean; failed: boolean };

/** Voice uses the same send/watch path as typed messages, with one foreground turn at a time. */
export class VoiceChatBridge {
  private queue: Turn[] = [];
  private current?: Turn;
  private seen = new Set<string>();
  private submitted = new Set<string>();
  private closed = false;
  private chat?: Chat;

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
    this.queue.push({ ...turn, messageId: crypto.randomUUID(), accepted: false, failed: false });
    this.notify();
    this.pump();
  }

  ownsMessage(messageId: string) {
    return this.submitted.has(messageId);
  }

  update(chat: Chat) {
    if (this.closed) return;
    this.chat = chat;
    const turn = this.current;
    if (turn?.accepted) {
      const user = chat.messages.find((message) => message.id === turn.messageId);
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
    this.queue.unshift(this.current);
    this.current = undefined;
    this.notify();
    this.pump();
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
