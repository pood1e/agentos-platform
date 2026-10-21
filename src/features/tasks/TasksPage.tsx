import { useQuery } from "@connectrpc/connect-query";
import { keepPreviousData } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { consoleClient } from "../../lib/console.js";
import { useWatch } from "../../lib/use-watch.js";
import { usePaging } from "../shared/paging.js";
import { TaskFilters } from "./TaskFilters.js";
import { TaskList } from "./TaskList.js";
import { TaskView } from "./TaskView.js";

async function* follow(taskId: string, signal: AbortSignal) {
  for await (const { task } of consoleClient.watchTask({ taskId }, { signal }))
    if (task) yield task;
}

export function TasksPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { taskId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const stateValue = ActivityState[search.get("state") as keyof typeof ActivityState];
  const state =
    typeof stateValue === "number" && stateValue !== ActivityState.UNSPECIFIED
      ? stateValue
      : undefined;
  const engineer = search.get("engineer") ?? "";
  const tag = search.get("tag") ?? "";
  const paging = usePaging(JSON.stringify([state, engineer, tag]), {
    value: search.get("query") ?? "",
    onChange: (value) => {
      const next = new URLSearchParams(search);
      if (value) next.set("query", value);
      else next.delete("query");
      setSearch(next, { replace: true });
    },
  });
  const list = useQuery(
    ConsoleService.method.listTasks,
    {
      pageToken: paging.pageToken,
      pageSize: paging.pageSize,
      query: paging.query,
      states: state === undefined ? [] : [state],
      engineer,
      tags: tag ? [tag] : [],
    },
    { refetchInterval: 3_000, placeholderData: keepPreviousData },
  );
  const selected = taskId || (!list.isPlaceholderData && list.data?.tasks[0]?.id) || "";
  const suffix = search.size ? `?${search}` : "";
  useEffect(() => {
    if (!taskId && selected) void navigate(`/tasks/${selected}${suffix}`, { replace: true });
  }, [taskId, selected, suffix, navigate]);
  const { value: detail, error } = useWatch(selected || undefined, (signal) =>
    follow(selected, signal),
  );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <TaskFilters
        state={state}
        engineer={engineer}
        tag={tag}
        availableTags={list.data?.availableTags ?? []}
        onChange={(field, value) => {
          const next = new URLSearchParams(search);
          if (!value || (field !== "tag" && value === "all")) next.delete(field);
          else next.set(field, value);
          if (field === "state" && value !== "AWAITING_APPROVAL") next.delete("approval");
          navigate(`/tasks${next.size ? `?${next}` : ""}`);
        }}
      />
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 xl:grid-cols-[280px_minmax(0,1fr)] xl:grid-rows-1">
        <TaskList
          tasks={list.data?.tasks ?? []}
          total={list.data?.totalSize ?? 0}
          paging={paging.controls(list.data?.nextPageToken)}
          selectedId={detail?.summary?.id ?? selected}
          selectedTitle={detail?.summary?.title}
          onSelect={(id) => navigate(`/tasks/${id}${suffix}`)}
        />
        {detail ? (
          <TaskView
            key={`${detail.summary?.id}:${selected}`}
            detail={detail}
            focusTaskId={selected}
            openApproval={search.get("approval") === "1"}
            availableTags={list.data?.availableTags ?? []}
          />
        ) : (
          <p className="flex items-center justify-center text-sm text-muted-foreground">
            {t(error || (list.data && !selected ? "task.noTasks" : "status.connecting"))}
          </p>
        )}
      </div>
    </div>
  );
}
