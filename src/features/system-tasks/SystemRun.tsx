import { ThreadPrimitive } from "@assistant-ui/react";
import { PanelRightClose } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import { can } from "../../../shared/permissions.js";
import { useAccess } from "../../lib/access.js";
import { WorkingAgents } from "../chat/AgentPresence.js";
import { ConversationRuntime } from "../chat/ConversationRuntime.js";
import { ConversationTranscript } from "../chat/ConversationTranscript.js";
import { useChat } from "../chat/use-chat.js";

const started = () => {};

/** A shared execution is a read-only native session; task managers maintain its tags. */
export function SystemRun({
  agent,
  session,
  onClose,
}: {
  agent: string;
  session: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const access = useAccess();
  const ref = { namespace: access.data?.workspace ?? "", name: agent };
  const chat = useChat(ref, session, started);
  return (
    <aside
      data-testid="system-run"
      aria-label={t("automation.execution")}
      className="flex min-h-0 min-w-0 flex-col gap-3"
    >
      <div className="flex shrink-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {chat.conversation?.title || t("automation.execution")}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("automation.closeExecution")}
          onClick={onClose}
        >
          <PanelRightClose />
        </Button>
      </div>
      {chat.error && (
        <Alert variant="destructive">
          <AlertDescription>{t(chat.error)}</AlertDescription>
        </Alert>
      )}
      {chat.conversation && !chat.messages.length ? (
        <p className="text-sm text-muted-foreground">{t("automation.noExecutions")}</p>
      ) : chat.conversation ? (
        <ConversationRuntime chat={chat}>
          <ThreadPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border">
            <ConversationTranscript
              chat={chat}
              tagsEditable={can(access.data, Capability.TASKS_MANAGE)}
            />
            <WorkingAgents chat={chat} entryAgentId={`${ref.namespace}/${ref.name}`} />
          </ThreadPrimitive.Root>
        </ConversationRuntime>
      ) : (
        !chat.error && (
          <Skeleton
            className="min-h-64 flex-1 rounded-xl"
            role="status"
            aria-label={t("status.connecting")}
          />
        )
      )}
    </aside>
  );
}
