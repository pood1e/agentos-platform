import { ThreadPrimitive } from "@assistant-ui/react";
import { skipToken, useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { SquarePen } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { useAccess } from "../../lib/access.js";
import { cn } from "../../lib/utils.js";
import { HistoryList } from "../shared/HistoryList.js";
import { usePaging } from "../shared/paging.js";
import { taskLocation } from "../tasks/task-location.js";
import { useTask } from "../tasks/use-task.js";
import { ChatComposer } from "./ChatComposer.js";
import { ConversationRuntime } from "./ConversationRuntime.js";
import { ConversationTranscript } from "./ConversationTranscript.js";
import { rememberConversation } from "./conversation-storage.js";
import { useChat } from "./use-chat.js";

const TaskPanel = lazy(() =>
  import("../tasks/TaskPanel.js").then((module) => ({ default: module.TaskPanel })),
);

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { contextId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const [dismissed, setDismissed] = useState("");
  const paging = usePaging();
  const access = useAccess();
  const name = access.data?.entryAgent?.name ?? "assistant";
  const agent = { namespace: access.data?.workspace ?? "", name };
  const chat = useChat(agent, contextId, (id) => navigate(`/chat/${id}`));
  const list = useQuery(
    ConsoleService.method.listConversations,
    agent.namespace
      ? {
          agent,
          pageToken: paging.pageToken,
          pageSize: paging.pageSize,
          query: paging.query,
        }
      : skipToken,
    { refetchInterval: 3_000, placeholderData: keepPreviousData },
  );
  useEffect(() => {
    if (access.data) rememberConversation(access.data, contextId);
  }, [contextId, access.data]);
  const title = chat.conversation?.title;
  const related = chat.messages.flatMap((message) =>
    message.tasks.map((task) => ({ task, messageId: message.id })),
  );
  const tasks = [...new Map(related.map(({ task }) => [task.id, task])).values()];
  const latest = related.at(-1);
  const latestKey = latest ? `${contextId}:${latest.messageId}:${latest.task.id}` : "";
  const previous = useRef(latestKey);
  const selected =
    search.get("task") ?? (latestKey && dismissed !== latestKey ? latest?.task.id : "") ?? "";
  const task = useTask(selected);
  useEffect(() => {
    const origin = task.value?.summary?.conversationContextId;
    if (origin && origin !== contextId)
      void navigate(
        taskLocation(
          { id: selected, conversationContextId: origin },
          search.get("approval") === "1",
        ),
        { replace: true },
      );
  }, [task.value?.summary?.conversationContextId, selected, contextId, navigate, search]);
  useEffect(() => {
    const old = previous.current;
    previous.current = latestKey;
    if (old && latestKey && old !== latestKey && search.has("task")) {
      const next = new URLSearchParams(search);
      next.delete("task");
      next.delete("approval");
      setSearch(next, { replace: true });
    }
  }, [latestKey, search, setSearch]);
  const selectTask = (id: string) => {
    const next = new URLSearchParams(search);
    next.set("task", id);
    next.delete("approval");
    setSearch(next);
  };
  return (
    <div
      data-testid="chat-workspace"
      className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 lg:grid-cols-[200px_minmax(0,1fr)] lg:grid-rows-1 lg:gap-5 xl:grid-cols-[220px_minmax(0,1fr)]"
    >
      <HistoryList
        kind="chat"
        entries={(list.data?.conversations ?? []).map((item) => ({
          id: item.contextId,
          title: item.title || t("chat.title"),
          detail: item.title,
        }))}
        total={list.data?.totalSize ?? 0}
        paging={paging.controls(list.data?.nextPageToken)}
        selectedId={contextId}
        selectedTitle={title}
        onSelect={(id) => navigate(`/chat/${id}`)}
        disabled={chat.sending}
      />
      <div
        className={cn(
          "grid min-h-0 min-w-0 grid-cols-1",
          selected && "xl:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] xl:gap-5",
        )}
      >
        <ConversationRuntime
          key={`${access.data?.workspace}:${access.data?.subject}:${name}:${contextId}`}
          chat={chat}
        >
          <ThreadPrimitive.Root
            data-testid="conversation"
            className={cn("min-h-0 min-w-0 flex-col", selected ? "hidden xl:flex" : "flex")}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1 sm:px-4">
              <div className="flex min-w-0 items-center gap-3">
                <h1 className="min-w-0 truncate text-sm font-medium">
                  {title || t("chat.assistant")}
                </h1>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("chat.new")}
                title={t("chat.new")}
                disabled={chat.sending || !access.data}
                onClick={() => {
                  chat.reset();
                  navigate("/chat");
                }}
              >
                <SquarePen />
              </Button>
            </div>
            <ConversationTranscript chat={chat} onTask={selectTask} />
            <ChatComposer chat={chat} />
          </ThreadPrimitive.Root>
        </ConversationRuntime>
        {selected && (
          <Suspense fallback={null}>
            <TaskPanel
              taskId={selected}
              detail={task.value}
              error={task.error}
              tasks={tasks}
              openApproval={search.get("approval") === "1"}
              onSelect={selectTask}
              onClose={() => {
                setDismissed(latestKey);
                const next = new URLSearchParams(search);
                next.delete("task");
                next.delete("approval");
                setSearch(next, { replace: true });
              }}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
