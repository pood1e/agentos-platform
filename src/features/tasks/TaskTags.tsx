import { createConnectQueryKey, useMutation } from "@connectrpc/connect-query";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Tags } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { TaskSummary } from "../../../gen/agentos/console/v1/task_pb.js";
import { errorKey } from "../../lib/errors.js";
import { usePack } from "../../lib/pack.js";
import { TagBadges } from "./TagBadges.js";

export function TaskTags({
  task,
  editable,
  available,
}: {
  task: TaskSummary;
  editable: boolean;
  available: string[];
}) {
  const { t } = useTranslation();
  const pack = usePack();
  const queryClient = useQueryClient();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ tags: task.tags, tagsVersion: task.tagsVersion });
  const [custom, setCustom] = useState("");
  const save = useMutation(ConsoleService.method.updateTaskTags, {
    onSuccess: () => {
      setOpen(false);
      void queryClient.invalidateQueries({
        queryKey: createConnectQueryKey({
          schema: ConsoleService.method.listTasks,
          cardinality: undefined,
        }),
      });
    },
    onError: (error) => toast.error(t(errorKey(error, "task.tagsFailed"))),
  });
  const choices = [...new Set([...pack.taskTags, ...available, ...draft.tags])].sort();
  const add = () => {
    const tag = custom.trim().normalize("NFC");
    if (!tag || draft.tags.length >= 32) return;
    setDraft({ ...draft, tags: [...new Set([...draft.tags, tag])] });
    setCustom("");
  };
  if (!editable && !task.tags.length) return null;
  return (
    <div data-testid="task-tags" className="flex min-w-0 flex-wrap items-center gap-1.5 px-1">
      <TagBadges tags={task.tags} />
      {editable && (
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (save.isPending) return;
            if (next) {
              setDraft({ tags: [...task.tags], tagsVersion: task.tagsVersion });
              setCustom("");
            }
            setOpen(next);
          }}
        >
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 text-xs">
              <Tags className="size-3.5" />
              {t("task.editTags")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("task.editTags")}</DialogTitle>
              <DialogDescription>{t("task.tagsHint")}</DialogDescription>
            </DialogHeader>
            <div className="max-h-64 space-y-3 overflow-y-auto p-1">
              {choices.map((tag, position) => (
                <Label key={tag} htmlFor={`${id}-${position}`} className="flex min-w-0 gap-2">
                  <Checkbox
                    id={`${id}-${position}`}
                    checked={draft.tags.includes(tag)}
                    disabled={
                      save.isPending || (!draft.tags.includes(tag) && draft.tags.length >= 32)
                    }
                    onCheckedChange={(checked) =>
                      setDraft({
                        ...draft,
                        tags: checked
                          ? [...draft.tags, tag]
                          : draft.tags.filter((value) => value !== tag),
                      })
                    }
                  />
                  <span className="truncate">
                    {t(`task.tagNames.${tag}`, { defaultValue: tag, nsSeparator: false })}
                  </span>
                </Label>
              ))}
            </div>
            <div className="flex min-w-0 gap-2">
              <Input
                aria-label={t("task.newTag")}
                placeholder={t("task.newTag")}
                value={custom}
                maxLength={40}
                disabled={save.isPending || draft.tags.length >= 32}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    add();
                  }
                }}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label={t("task.addTag")}
                onClick={add}
                disabled={save.isPending || !custom.trim() || draft.tags.length >= 32}
              >
                <Plus />
              </Button>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={save.isPending}>
                {t("common.close")}
              </Button>
              <Button
                disabled={save.isPending || !!custom.trim()}
                onClick={() => save.mutate({ taskId: task.id, ...draft })}
              >
                {t("configuration.save")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
