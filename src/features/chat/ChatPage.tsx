import { ThreadPrimitive } from "@assistant-ui/react";
import { useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { SquarePen } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { ConversationKind } from "../../../gen/agentos/console/v1/conversation_pb.js";
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
  const chat = useChat(ConversationKind.ASSISTANT, contextId, (id) => navigate(`/chat/${id}`));
  const list = useQuery(
    ConsoleService.method.listConversations,
    {
      kind: ConversationKind.ASSISTANT,
      pageToken: paging.pageToken,
      pageSize: paging.pageSize,
      query: paging.query,
    },
    { refetchInterval: 3_000, placeholderData: keepPreviousData },
  );
  useEffect(() => {
    rememberConversation(contextId);
  }, [contextId]);
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
        onSelect={(id) => navigate(`/chat/${id}`)}
        disabled={chat.sending}
      />
      <ConversationRuntime key={contextId} chat={chat}>
        <ThreadPrimitive.Root data-testid="conversation" className="flex min-h-0 min-w-0 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 px-3 py-1 sm:px-4">
            <h1 className="min-w-0 truncate text-sm font-medium">{title || t("chat.assistant")}</h1>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("chat.new")}
              title={t("chat.new")}
              disabled={chat.sending}
              onClick={() => {
                chat.reset();
                navigate("/chat");
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
