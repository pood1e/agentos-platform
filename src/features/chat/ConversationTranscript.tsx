import {
  groupPartByType,
  MessagePrimitive,
  type ThreadMessage,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import type { TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";
import { Approval } from "../shared/Approval.js";
import { Avatar } from "../shared/Avatar.js";
import { TaskTags } from "../tasks/TaskTags.js";
import { AgentResult } from "./AgentResult.js";
import { SpeechOutput } from "./speech/SpeechControls.js";
import { ToolFallback } from "./ToolFallback.js";
import type { Chat } from "./use-chat.js";

const plugins = [remarkGfm];
const groupTools = groupPartByType({ "tool-call": ["group-mcp"] });
const AssistantText = ({ id }: { id?: string }) => {
  const containerProps = {
    className: "agent-markdown text-sm text-foreground",
    "data-testid": "chat-text-part",
    "data-part-id": id,
  };
  return (
    <MarkdownTextPrimitive
      containerProps={containerProps}
      remarkPlugins={plugins}
      skipHtml
      smooth={false}
    />
  );
};

function ConversationMessage({
  message,
  tasks,
  editable,
}: {
  message: ThreadMessage;
  tasks: TaskSummary[];
  editable: boolean;
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
          {user ? (
            <MessagePrimitive.Parts />
          ) : (
            <MessagePrimitive.GroupedParts groupBy={groupTools} indicator="never">
              {({ part, children }) => {
                switch (part.type) {
                  case "group-mcp":
                    return (
                      <div
                        data-testid="chat-tool-group"
                        className="my-2 flex max-w-full flex-wrap items-center gap-1.5"
                      >
                        {children}
                      </div>
                    );
                  case "text":
                  case "reasoning":
                    return <AssistantText id={part.id} />;
                  case "tool-call":
                    return <ToolFallback {...part} />;
                  case "data":
                    return part.name === "agent-result" ? <AgentResult {...part} /> : null;
                  default:
                    return null;
                }
              }}
            </MessagePrimitive.GroupedParts>
          )}
        </div>
        {!user && <SpeechOutput />}
      </MessagePrimitive.Root>
      {tasks.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1">
          {tasks.map((task) => (
            <TaskTags key={task.id} task={task} editable={editable} available={[]} />
          ))}
        </div>
      )}
    </>
  );
}

export function ConversationTranscript({ chat }: { chat: Chat }) {
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
                tasks={tasks.get(message.id) ?? []}
                editable={chat.conversation?.operate ?? false}
              />
            )}
          </ThreadPrimitive.Messages>
          {(chat.conversation?.interactions ?? []).map((interaction) => (
            <div key={interaction.id} className="rounded-xl border p-3">
              <Approval interaction={interaction} operate={chat.conversation?.operate ?? false} />
            </div>
          ))}
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
