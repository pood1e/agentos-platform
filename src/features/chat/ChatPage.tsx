import { ThreadPrimitive } from "@assistant-ui/react";
import { skipToken, useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { useAccess } from "../../lib/access.js";
import { usePaging } from "../shared/paging.js";
import { useTask } from "../tasks/use-task.js";
import { WorkingAgents } from "./AgentPresence.js";
import { ChatComposer } from "./ChatComposer.js";
import { ChatHistory } from "./ChatHistory.js";
import { ConversationRuntime } from "./ConversationRuntime.js";
import { ConversationTranscript } from "./ConversationTranscript.js";
import { forgetConversation, rememberConversation } from "./conversation-storage.js";
import { useChat } from "./use-chat.js";
import { VoiceCallContext } from "./voice/context.js";
import { useVoiceCall } from "./voice/use-voice-call.js";
import { VoiceCallControls } from "./voice/VoiceCallControls.js";

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { contextId = "" } = useParams();
  const [search] = useSearchParams();
  const paging = usePaging();
  const access = useAccess();
  const name = access.data?.entryAgent?.name ?? "assistant";
  const agent = { namespace: access.data?.workspace ?? "", name };
  const chat = useChat(agent, contextId, (id) => navigate(`/chat/${id}`));
  const call = useVoiceCall(chat, contextId);
  const linked = useTask(search.get("task") ?? "");
  useEffect(() => {
    const origin = linked.value?.summary?.conversationContextId;
    if (origin) void navigate(`/chat/${encodeURIComponent(origin)}`, { replace: true });
  }, [linked.value?.summary?.conversationContextId, navigate]);
  const list = useQuery(
    ConsoleService.method.listConversations,
    agent.namespace
      ? { agent, pageToken: paging.pageToken, pageSize: paging.pageSize, query: paging.query }
      : skipToken,
    { refetchInterval: 3_000, placeholderData: keepPreviousData },
  );
  useEffect(() => {
    if (access.data) rememberConversation(access.data, contextId);
  }, [contextId, access.data]);
  const title = chat.conversation?.title;
  return (
    <div
      data-testid="chat-workspace"
      className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-3 lg:grid-cols-[240px_minmax(0,1fr)] lg:grid-rows-1 lg:gap-5 xl:grid-cols-[256px_minmax(0,1fr)]"
    >
      <ChatHistory
        entries={list.data?.conversations ?? []}
        total={list.data?.totalSize ?? 0}
        paging={paging.controls(list.data?.nextPageToken)}
        selectedId={contextId}
        onSelect={(id) => navigate(`/chat/${id}`)}
        disabled={chat.sending || !access.data}
        onNew={() => {
          void call.stop();
          chat.reset();
          paging.controls().onSearch("");
          navigate("/chat");
        }}
        onDeleted={(id) => {
          if (access.data) forgetConversation(access.data, id);
          if (contextId === id) {
            void call.stop();
            chat.reset();
            navigate("/chat", { replace: true });
          }
        }}
        onRefresh={() => list.refetch()}
      />
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1 sm:px-4">
          <h1 className="min-w-0 truncate text-sm font-medium">{title || t("chat.assistant")}</h1>
        </div>
        {linked.error && (
          <Alert variant="destructive">
            <AlertDescription>{t(linked.error)}</AlertDescription>
          </Alert>
        )}
        <VoiceCallControls call={call} disabled={!chat.ready || !chat.conversation?.operate} />
        <VoiceCallContext value={call.active}>
          <ConversationRuntime
            key={`${access.data?.workspace}:${access.data?.subject}:${name}:${contextId}`}
            chat={chat}
          >
            <ThreadPrimitive.Root
              data-testid="conversation"
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              <ConversationTranscript chat={chat} />
              <WorkingAgents chat={chat} entryAgentId={`${agent.namespace}/${agent.name}`} />
              <ChatComposer chat={chat} />
            </ThreadPrimitive.Root>
          </ConversationRuntime>
        </VoiceCallContext>
      </div>
    </div>
  );
}
