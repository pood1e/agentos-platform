import { ThreadPrimitive } from "@assistant-ui/react";
import { skipToken, useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { SquarePen } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { useAccess } from "../../lib/access.js";
import { HistoryList } from "../shared/HistoryList.js";
import { usePaging } from "../shared/paging.js";
import { ChatComposer } from "./ChatComposer.js";
import { ConversationRuntime } from "./ConversationRuntime.js";
import { ConversationTranscript } from "./ConversationTranscript.js";
import { rememberConversation } from "./conversation-storage.js";
import { useChat } from "./use-chat.js";

export function ChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { contextId = "" } = useParams();
  const paging = usePaging();
  const access = useAccess();
  const [search] = useSearchParams();
  const name = search.get("agent") || access.data?.entryAgent?.name || "assistant";
  const agent = { namespace: access.data?.workspace ?? "", name };
  const suffix = `?agent=${encodeURIComponent(name)}`;
  const members = useQuery(ConsoleService.method.listEngineers, {});
  const choices = [
    ...new Map(
      [
        {
          id: `${agent.namespace}/${access.data?.entryAgent?.name ?? "assistant"}`,
          name: access.data?.entryAgent?.name ?? "assistant",
        },
        ...(members.data?.engineers ?? []),
      ].map((item) => [item.id, item]),
    ).values(),
  ];
  const chat = useChat(agent, contextId, (id) => navigate(`/chat/${id}${suffix}`));
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
    rememberConversation(contextId, suffix);
  }, [contextId, suffix]);
  const title = chat.conversation?.title;
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
        onSelect={(id) => navigate(`/chat/${id}${suffix}`)}
        disabled={chat.sending}
      />
      <ConversationRuntime key={`${name}:${contextId}`} chat={chat}>
        <ThreadPrimitive.Root data-testid="conversation" className="flex min-h-0 min-w-0 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1 sm:px-4">
            <div className="flex min-w-0 items-center gap-3">
              <Select
                value={name}
                disabled={chat.sending}
                onValueChange={(value) => navigate(`/chat?agent=${encodeURIComponent(value)}`)}
              >
                <SelectTrigger aria-label={t("chat.agent")} className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice.id} value={choice.id.split("/").at(-1) ?? ""}>
                      {choice.name || choice.id.split("/").at(-1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <h1 className="min-w-0 truncate text-sm font-medium">
                {title || t("chat.assistant")}
              </h1>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.new")}
              title={t("chat.new")}
              disabled={chat.sending}
              onClick={() => {
                chat.reset();
                navigate(`/chat${suffix}`);
              }}
            >
              <SquarePen />
            </Button>
          </div>
          <ConversationTranscript chat={chat} />
          <ChatComposer chat={chat} />
        </ThreadPrimitive.Root>
      </ConversationRuntime>
    </div>
  );
}
