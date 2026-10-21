import { PanelRightClose } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { TaskDetail, TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";
import { TaskView } from "./TaskView.js";

export function TaskPanel({
  taskId,
  detail,
  error,
  tasks,
  openApproval,
  onSelect,
  onClose,
}: {
  taskId: string;
  detail?: TaskDetail;
  error: string;
  tasks: TaskSummary[];
  openApproval: boolean;
  onSelect: (taskId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const content = (
    <>
      <div className="flex shrink-0 items-center gap-2">
        {tasks.length > 1 ? (
          <Select value={detail?.summary?.id ?? taskId} onValueChange={onSelect}>
            <SelectTrigger aria-label={t("chat.relatedTasks")} className="min-w-0 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {tasks.map((task) => (
                <SelectItem key={task.id} value={task.id}>
                  {task.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="flex-1 text-sm font-medium">{t("chat.taskDetails")}</span>
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t("chat.closeTask")} onClick={onClose}>
          <PanelRightClose />
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{t(error)}</AlertDescription>
        </Alert>
      )}
      {detail ? (
        <TaskView
          key={taskId}
          detail={detail}
          focusTaskId={taskId}
          openApproval={openApproval}
          availableTags={tasks.flatMap((task) => task.tags)}
        />
      ) : (
        !error && (
          <Skeleton
            className="min-h-64 flex-1 rounded-xl"
            role="status"
            aria-label={t("status.connecting")}
          />
        )
      )}
    </>
  );
  return (
    <aside
      data-testid="chat-task-panel"
      aria-label={t("chat.taskDetails")}
      className="flex min-h-0 min-w-0 flex-col gap-3"
    >
      {content}
    </aside>
  );
}
