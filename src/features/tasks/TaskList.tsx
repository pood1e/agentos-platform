import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";
import { HistoryList, type HistoryPage } from "../shared/HistoryList.js";
import { labelKey } from "../status/activity.js";
import { appearance, StatusIcon } from "../status/Status.js";
import { TagBadges } from "./TagBadges.js";

export function TaskList({
  tasks,
  total,
  paging,
  selectedId,
  selectedTitle,
  onSelect,
}: {
  tasks: TaskSummary[];
  total: number;
  paging: HistoryPage;
  selectedId: string;
  selectedTitle?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <HistoryList
      kind="task"
      total={total}
      paging={paging}
      selectedId={selectedId}
      selectedTitle={selectedTitle}
      onSelect={onSelect}
      entries={tasks.map((task) => ({
        id: task.id,
        title: task.title,
        detail: `${task.prompt} ${task.id}`,
        metadata: task.tags.length ? <TagBadges tags={task.tags} compact /> : undefined,
        status: (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label={t(labelKey(task.state))}
                className="shrink-0"
                style={{ color: appearance(task.state).color }}
              >
                <StatusIcon state={task.state} className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">{t(labelKey(task.state))}</TooltipContent>
          </Tooltip>
        ),
      }))}
    />
  );
}
