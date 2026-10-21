import {
  MessagePrimitive,
  type ThreadMessage,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowDown, ArrowUpRight, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import type { TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";
import { Approval } from "../shared/Approval.js";
import { Avatar } from "../shared/Avatar.js";
import { appearance, StatusIcon } from "../status/Status.js";
import { SpeechOutput } from "./speech/SpeechControls.js";
import type { Chat } from "./use-chat.js";

const plugins = [remarkGfm];
const AssistantText = () => (
  <MarkdownTextPrimitive
    remarkPlugins={plugins}
    skipHtml
    smooth={false}
    className="agent-markdown text-sm text-foreground"
  />
);

function ConversationMessage({
  message,
  tasks,
  onTask,
}: {
  message: ThreadMessage;
  tasks: TaskSummary[];
  onTask: (id: string) => void;
}) {
  const { t } = useTranslation();
  const user = message.role === "user";
  return (
    <>
      <MessagePrimitive.Root
        role="article"
        aria-label={t(user ? "chat.you" : "chat.assistant")}
        data-testid="chat-message"
        data-message-id={message.id}
        className={
          user ? "grid grid-cols-[minmax(32px,1fr)_auto] content-start gap-y-2" : "w-full min-w-0"
        }
      >
        <div
          data-testid="chat-message-content"
          dir="auto"
          className={
            user
              ? "col-start-2 min-w-0 rounded-2xl bg-muted px-4 py-2 text-sm leading-6 wrap-anywhere"
              : "min-w-0 leading-6"
          }
        >
          <MessagePrimitive.Parts components={user ? undefined : { Text: AssistantText }} />
        </div>
        {!user && <SpeechOutput />}
      </MessagePrimitive.Root>
      {tasks.map((task) => (
        <Button
          key={task.id}
          data-testid="chat-task"
          variant="outline"
          className="flex h-auto w-full min-w-0 justify-start gap-2 py-2.5"
          aria-label={t("chat.viewTask", { title: task.title })}
          onClick={() => onTask(task.id)}
        >
          <span style={{ color: appearance(task.state).color }}>
            <StatusIcon state={task.state} className="size-4 shrink-0" />
          </span>
          <span className="min-w-0 flex-1 truncate text-left text-xs">{task.title}</span>
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      ))}
    </>
  );
}

export function ConversationTranscript({
  chat,
  onTask,
}: {
  chat: Chat;
  onTask?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const tasks = new Map(chat.messages.map((message) => [message.id, message.tasks]));
  const empty = useAuiState((state) => state.thread.messages.length === 0);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        data-testid="chat-viewport"
        role="log"
        aria-label={t("chat.history")}
        aria-live="polite"
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 p-3 sm:p-4">
          {empty && (
            <div className="flex min-h-[45dvh] flex-col items-center justify-center gap-5 text-center">
              <Avatar className="h-32 w-28" />
              <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                {t("chat.welcome")}
              </h2>
            </div>
          )}
          <ThreadPrimitive.Messages>
            {({ message }) => (
              <ConversationMessage
                message={message}
                tasks={onTask ? (tasks.get(message.id) ?? []) : []}
                onTask={onTask ?? (() => {})}
              />
            )}
          </ThreadPrimitive.Messages>
          {chat.pending.map((interaction) => (
            <div key={interaction.id} className="rounded-xl border p-3">
              <Approval interaction={interaction} operate={chat.conversation?.operate ?? false} />
            </div>
          ))}
          {(chat.sending || chat.busy) && !chat.pending.length && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 motion-safe:animate-spin" />
              {t("chat.processing")}
            </p>
          )}
        </div>
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={t("chat.scrollLatest")}
          title={t("chat.scrollLatest")}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full disabled:invisible"
        >
          <ArrowDown className="size-4" />
        </Button>
      </ThreadPrimitive.ScrollToBottom>
    </div>
  );
}
