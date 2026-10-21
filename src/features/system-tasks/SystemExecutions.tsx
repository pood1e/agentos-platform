import { useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { Failure } from "../management/ResourcePage.js";
import { PageControl } from "../shared/PageControl.js";
import { usePaging } from "../shared/paging.js";
import { Status } from "../status/Status.js";
import { TagBadges } from "../tasks/TagBadges.js";
import { taskLocation } from "../tasks/task-location.js";
import { scheduledTime } from "./format.js";

export function SystemExecutions() {
  const { t } = useTranslation();
  const paging = usePaging();
  const list = useQuery(
    ConsoleService.method.listTasks,
    {
      systemOnly: true,
      query: paging.query,
      pageToken: paging.pageToken,
      pageSize: paging.pageSize,
    },
    { refetchInterval: 3_000, placeholderData: keepPreviousData },
  );
  const next = list.data?.nextPageToken;
  const page = paging.controls(next);
  return (
    <section className="space-y-4" aria-label={t("automation.history")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t("automation.history")}</h2>
        <Input
          className="w-full sm:w-64"
          aria-label={t("task.searchLabel")}
          placeholder={t("task.searchPlaceholder")}
          value={page.search}
          onChange={(event) => page.onSearch(event.target.value)}
        />
      </div>
      <Failure error={list.error} />
      <Table data-testid="system-executions">
        <TableHeader>
          <TableRow>
            <TableHead>{t("automation.name")}</TableHead>
            <TableHead>{t("automation.status")}</TableHead>
            <TableHead className="hidden sm:table-cell">{t("automation.updated")}</TableHead>
            <TableHead>{t("automation.result")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data?.tasks.map((task) => (
            <TableRow key={task.id}>
              <TableCell className="max-w-64 whitespace-normal">
                <p className="line-clamp-2">{task.title}</p>
                <TagBadges tags={task.tags} />
              </TableCell>
              <TableCell>
                <Status state={task.state} />
              </TableCell>
              <TableCell className="hidden whitespace-nowrap sm:table-cell">
                {scheduledTime(task.updatedAt)}
              </TableCell>
              <TableCell>
                <Link
                  className="whitespace-nowrap text-primary hover:underline"
                  to={taskLocation(task)}
                >
                  {t("automation.viewExecution")}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {list.isSuccess && !list.data.tasks.length && (
        <p className="text-sm text-muted-foreground">{t("automation.noExecutions")}</p>
      )}
      {(page.page > 0 || next) && (
        <PageControl
          page={page.page}
          hasNext={!!next}
          onPage={page.onPage}
          label={t("automation.history")}
          disabled={list.isFetching}
        />
      )}
    </section>
  );
}
