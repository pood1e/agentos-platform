import { useTranslation } from "react-i18next";
import { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import type { TaskRun } from "../../../gen/agentos/execution/v1/task_pb.js";
import { active, awaiting } from "../status/activity.js";
import { Status } from "../status/Status.js";

const groups = [
  {
    key: "failed",
    match: (state: ActivityState) =>
      state === ActivityState.FAILED || state === ActivityState.REJECTED,
  },
  { key: "waiting", match: awaiting },
  { key: "working", match: active },
  { key: "canceled", match: (state: ActivityState) => state === ActivityState.CANCELED },
  { key: "completed", match: () => true },
] as const;

/** Summary of background branches; their results never block the main task. */
export function BackgroundTasks({
  runs,
  onSelect,
}: {
  runs: TaskRun[];
  onSelect: (run: TaskRun) => void;
}) {
  const { t } = useTranslation();
  const background = runs.filter((run) => run.background);
  if (!background.length) return null;
  const group = groups.find(({ match }) => background.some((run) => match(run.state))) ?? groups[4];
  const selected = background.filter((run) => group.match(run.state));
  const first = selected[0];
  return (
    <div data-testid="background-status" className="inline-flex">
      <Status
        state={first?.state ?? ActivityState.SUCCEEDED}
        onClick={() => first && onSelect(first)}
      >
        {t(`background.${group.key}`, { count: selected.length })}
      </Status>
    </div>
  );
}
