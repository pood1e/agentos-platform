import { useQuery } from "@connectrpc/connect-query";
import { ClipboardClock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../gen/agentos/console/v1/state_pb.js";

export function PendingApprovals() {
  const { t } = useTranslation();
  const pending = useQuery(
    ConsoleService.method.listTasks,
    { states: [ActivityState.AWAITING_APPROVAL], pageSize: 1 },
    { refetchInterval: 3_000 },
  );
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link to="/tasks?state=AWAITING_APPROVAL&approval=1" aria-label={t("task.pendingApprovals")}>
        <ClipboardClock />
        <span className="hidden sm:inline">{t("task.pendingApprovals")}</span>
        {pending.data && <Badge variant="secondary">{pending.data.totalSize}</Badge>}
      </Link>
    </Button>
  );
}
