import { ThreadPrimitive } from "@assistant-ui/react";
import { create } from "@bufbuild/protobuf";
import { skipToken, useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import {
  AuthorizationResourceSchema,
  Permission,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { useAccess } from "../../lib/access.js";
import { useResourceAccess } from "../../lib/authorization.js";
import { useSpeechCapabilities } from "../../lib/speech.js";
import { authorizationHref } from "../authorization/resource-location.js";
import { usePaging } from "../shared/paging.js";
import { WorkingAgents } from "./AgentPresence.js";
import { ChatComposer } from "./ChatComposer.js";
import { ChatHistory } from "./ChatHistory.js";
import { ConversationRuntime } from "./ConversationRuntime.js";
import { ConversationTranscript } from "./ConversationTranscript.js";
import { forgetConversation, rememberConversation } from "./conversation-storage.js";
import { useChat } from "./use-chat.js";
import { VoiceCallContext } from "./voice/context.js";

const VoiceCallControls = lazy(() =>
  import("./voice/VoiceCallControls.js").then((module) => ({
    default: module.VoiceCallControls,
  })),
);

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { contextId = "" } = useParams();
  const paging = usePaging();
  const access = useAccess();
  const name = access.data?.entryAgent?.name ?? "assistant";
  const agent = { namespace: access.data?.workspace ?? "", name };
  const sessionScope = contextId
    ? create(AuthorizationResourceSchema, { resource: { case: "sessionId", value: contextId } })
    : undefined;
  const sessionAccess = useResourceAccess(sessionScope);
  const canViewAccess =
    sessionAccess.isSuccess && sessionAccess.data?.allowedActions.includes(Permission.ACCESS_READ);
  const chat = useChat(agent, contextId, (id) => navigate(`/chat/${id}`));
  const voice = useSpeechCapabilities().data?.enabled === true;
  const [calling, setCalling] = useState(false);
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
          chat.reset();
          paging.controls().onSearch("");
          navigate("/chat");
        }}
        onDeleted={(id) => {
          if (access.data) forgetConversation(access.data, id);
          if (contextId === id) {
            chat.reset();
            navigate("/chat", { replace: true });
          }
        }}
        onRefresh={() => list.refetch()}
      />
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1 sm:px-4">
          <h1 className="min-w-0 truncate text-sm font-medium">{title || t("chat.assistant")}</h1>
          {canViewAccess && sessionScope && (
            <Button asChild variant="outline" size="sm" className="shrink-0">
              <Link to={authorizationHref(sessionScope)}>
                <ShieldCheck />
                {t("authorization.title")}
              </Link>
            </Button>
          )}
        </div>
        {voice && (
          <Suspense fallback={null}>
            <VoiceCallControls
              contextId={contextId}
              disabled={!chat.ready || !chat.conversation?.operate}
              onActive={setCalling}
              onStarted={(id) => navigate(`/chat/${id}`)}
            />
          </Suspense>
        )}
        <VoiceCallContext value={calling}>
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
