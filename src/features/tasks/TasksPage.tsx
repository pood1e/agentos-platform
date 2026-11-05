import { timestampDate } from "@bufbuild/protobuf/wkt";
import { skipToken, useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { useAccess } from "../../lib/access.js";
import { useSearchParam } from "../../lib/use-search-param.js";
import { Avatar } from "../shared/Avatar.js";
import { agentName } from "../shared/agents.js";
import { ExecutionScopeTabs, useExecutionScope } from "../shared/execution-scope.js";
import { usePaging } from "../shared/paging.js";
import { ResourcePage } from "../shared/ResourcePage.js";
import { labelKey } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { taskLocation } from "./task-location.js";

const states = [
  ActivityState.SUBMITTED,
  ActivityState.WORKING,
  ActivityState.AWAITING_APPROVAL,
  ActivityState.AWAITING_INPUT,
  ActivityState.SUCCEEDED,
  ActivityState.FAILED,
  ActivityState.REJECTED,
  ActivityState.CANCELED,
];
const all = "*";

function Filter({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value || all} onValueChange={(next) => onChange(next === all ? "" : next)}>
      <SelectTrigger aria-label={label} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={all}>{allLabel}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Root operations of the execution scope; filters live in the URL and survive opening a task. */
export function TasksPage() {
  const { t, i18n } = useTranslation();
  const namespace = useAccess().data?.workspace?.namespace ?? "";
  const scope = useExecutionScope();
  const [stateParam, selectState] = useSearchParam("state");
  const [agent, selectAgent] = useSearchParam("agent");
  const state = states.find((item) => String(item) === stateParam);
  const paging = usePaging(JSON.stringify([scope.systemOnly, state, agent]));
  const agents = useQuery(ConsoleService.method.listAgents, {});
  const members = (agents.data?.agents ?? []).filter((member) =>
    member.id.startsWith(`${namespace}/`),
  );
  const tasks = useQuery(
    ConsoleService.method.listTasks,
    namespace
      ? {
          pageSize: paging.pageSize,
          pageToken: paging.pageToken,
          query: paging.query,
          states: state ? [state] : [],
          agent: agent ? { namespace, name: agent } : undefined,
          systemOnly: scope.systemOnly,
        }
      : skipToken,
    { refetchInterval: 5_000, placeholderData: keepPreviousData },
  );
  const page = paging.controls(tasks.data?.nextPageToken);
  const time = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: "short",
    timeStyle: "short",
  });
  return (
    <ResourcePage
      title={t("task.listTitle")}
      query={page.search}
      onQuery={page.onSearch}
      total={tasks.data?.totalSize ?? 0}
      pending={tasks.isPending}
      fetching={tasks.isFetching}
      error={tasks.error}
      onRefresh={() => void tasks.refetch()}
      page={page.page}
      onPage={page.onPage}
      toolbar={
        <>
          <Filter
            label={t("task.filterState")}
            allLabel={t("task.allStates")}
            value={state ? String(state) : ""}
            options={states.map((item) => ({ value: String(item), label: t(labelKey(item)) }))}
            onChange={selectState}
          />
          <Filter
            label={t("task.filterAgent")}
            allLabel={t("task.allAgents")}
            value={agent}
            options={members.map((member) => ({
              value: member.id.slice(namespace.length + 1),
              label: agentName(member),
            }))}
            onChange={selectAgent}
          />
          <ExecutionScopeTabs scope={scope} />
        </>
      }
    >
      <Table className="min-w-3xl">
        <TableHeader>
          <TableRow>
            <TableHead>{t("task.name")}</TableHead>
            <TableHead>{t("task.agent")}</TableHead>
            <TableHead>{t("task.state")}</TableHead>
            <TableHead>{t("task.updatedAt")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.data?.tasks.map((task) => {
            const member = members.find(
              (item) => item.id === `${task.agent?.namespace}/${task.agent?.name}`,
            );
            return (
              <TableRow key={task.id}>
                <TableCell className="w-full max-w-0 truncate">
                  <Link
                    to={taskLocation(task)}
                    title={task.prompt}
                    className="font-medium hover:underline"
                  >
                    {task.title}
                  </Link>
                  {task.prompt.trim() !== task.title && (
                    <p className="mt-1 truncate text-xs text-muted-foreground">{task.prompt}</p>
                  )}
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <Avatar role={member?.template?.name ?? ""} className="h-6 w-5" />
                    <span className="max-w-40 truncate">
                      {member ? agentName(member) : task.agent?.name}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <Status state={task.state} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  {task.updatedAt && time.format(timestampDate(task.updatedAt))}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ResourcePage>
  );
}
