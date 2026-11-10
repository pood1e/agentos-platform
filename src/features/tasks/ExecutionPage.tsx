import { ThreadPrimitive } from "@assistant-ui/react";
import { create } from "@bufbuild/protobuf";
import { PanelRightClose, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AuthorizationResourceSchema,
  Permission,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { useAccess } from "../../lib/access.js";
import { useResourceAccess } from "../../lib/authorization.js";
import { authorizationHref } from "../authorization/resource-location.js";
import { WorkingAgents } from "../chat/AgentPresence.js";
import { ConversationRuntime } from "../chat/ConversationRuntime.js";
import { ConversationTranscript } from "../chat/ConversationTranscript.js";
import { useChat } from "../chat/use-chat.js";

const started = () => {};

/** Displays a shared execution as a read-only native session. */
export function ExecutionPage() {
  const { agent = "", session = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Closing returns to the list that opened the execution; a direct visit has no such entry.
  const close = () => void (location.key === "default" ? navigate("/chat") : navigate(-1));
  const { t } = useTranslation();
  const access = useAccess();
  const ref = { namespace: access.data?.workspace?.namespace ?? "", name: agent };
  const chat = useChat(ref, session, started);
  const sessionScope = session
    ? create(AuthorizationResourceSchema, { resource: { case: "sessionId", value: session } })
    : undefined;
  const sessionAccess = useResourceAccess(sessionScope);
  const canViewAccess =
    sessionAccess.isSuccess && sessionAccess.data?.allowedActions.includes(Permission.ACCESS_READ);
  return (
    <aside
      data-testid="execution-view"
      aria-label={t("task.execution")}
      className="flex min-h-0 min-w-0 flex-col gap-3"
    >
      <div className="flex shrink-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {chat.conversation?.title || t("task.execution")}
        </span>
        {canViewAccess && sessionScope && (
          <Button asChild variant="outline" size="sm">
            <Link to={authorizationHref(sessionScope)}>
              <ShieldCheck />
              {t("authorization.title")}
            </Link>
          </Button>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t("common.close")} onClick={close}>
          <PanelRightClose />
        </Button>
      </div>
      {chat.error && (
        <Alert variant="destructive">
          <AlertDescription>{t(chat.error)}</AlertDescription>
        </Alert>
      )}
      {chat.conversation && !chat.messages.length ? (
        <p className="text-sm text-muted-foreground">{t("chat.empty")}</p>
      ) : chat.conversation ? (
        <ConversationRuntime chat={chat}>
          <ThreadPrimitive.Root className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border">
            <ConversationTranscript chat={chat} />
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
