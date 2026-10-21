import { useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { ClipboardClock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { usePaging } from "../features/shared/paging.js";
import { taskLocation } from "../features/tasks/task-location.js";

export function PendingApprovals() {
  const { t } = useTranslation();
  const paging = usePaging();
  const pending = useQuery(
    ConsoleService.method.listTasks,
    {
      states: [ActivityState.AWAITING_APPROVAL],
      pageSize: paging.pageSize,
      pageToken: paging.pageToken,
    },
    { refetchInterval: 3_000, placeholderData: keepPreviousData },
  );
  const next = pending.data?.nextPageToken;
  const page = paging.controls(next);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("task.pendingApprovals")}>
          <ClipboardClock />
          <span className="hidden sm:inline">{t("task.pendingApprovals")}</span>
          {pending.data && <Badge variant="secondary">{pending.data.totalSize}</Badge>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        {pending.data?.tasks.map((task) => (
          <DropdownMenuItem key={task.id} asChild>
            <Link to={taskLocation(task, true)} className="whitespace-normal">
              {task.title}
            </Link>
          </DropdownMenuItem>
        ))}
        {pending.isSuccess && !pending.data.tasks.length && (
          <p className="px-3 py-4 text-sm text-muted-foreground">{t("task.noPending")}</p>
        )}
        {(page.page > 0 || next) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={pending.isFetching || page.page === 0}
              onSelect={(event) => {
                event.preventDefault();
                page.onPage(page.page - 1);
              }}
            >
              {t("pagination.previous")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending.isFetching || !next}
              onSelect={(event) => {
                event.preventDefault();
                page.onPage(page.page + 1);
              }}
            >
              {t("pagination.next")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
