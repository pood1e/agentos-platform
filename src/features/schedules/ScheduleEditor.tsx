import { create } from "@bufbuild/protobuf";
import { useMutation, useQuery } from "@connectrpc/connect-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import type { ScheduleTemplate } from "../../../gen/agentos/console/v1/pack_pb.js";
import { ResourceReferenceSchema } from "../../../gen/kagent/api/v1/common_pb.js";
import type { ScheduledRun } from "../../../gen/kagent/api/v1/scheduled_runs_pb.js";
import { agentName } from "../shared/agents.js";
import { SaveButton } from "../shared/ResourceDialog.js";
import { Failure } from "../shared/ResourcePage.js";
import { agentId, editDraft, newDraft, timeoutMinutes, withTimeout } from "./schedule-draft.js";

/** Creates a schedule owned by the caller, from scratch or a solution template, or edits one. */
export function ScheduleEditor({
  run,
  template,
  onSaved,
}: {
  run?: ScheduledRun;
  template?: ScheduleTemplate;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const agents = useQuery(ConsoleService.method.listAgents, {});
  const [draft, setDraft] = useState(() => (run ? editDraft(run) : newDraft(template)));
  const [requestId] = useState(() => crypto.randomUUID());
  const add = useMutation(ConsoleService.method.createScheduledRun, { onSuccess: onSaved });
  const update = useMutation(ConsoleService.method.updateScheduledRun, { onSuccess: onSaved });
  const config = draft.config;
  const set = (patch: Partial<typeof config>) =>
    setDraft({ ...draft, config: { ...config, ...patch } });
  const save = () =>
    run
      ? update.mutate({ scheduledRunId: run.id, etag: run.etag, config })
      : add.mutate({ agent: draft.agent, requestId, config });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="text-xs text-muted-foreground">{t("schedule.owner")}</p>
      <div className="space-y-2">
        <Label>{t("schedule.agent")}</Label>
        <Select
          required
          disabled={!!run}
          value={draft.agent ? agentId(draft.agent) : ""}
          onValueChange={(value) => {
            const [namespace = "", name = ""] = value.split("/");
            setDraft({ ...draft, agent: create(ResourceReferenceSchema, { namespace, name }) });
          }}
        >
          <SelectTrigger aria-label={t("schedule.agent")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agents.data?.agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agentName(agent)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="schedule-name">{t("schedule.name")}</Label>
        <Input
          id="schedule-name"
          required
          maxLength={200}
          value={config.name}
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="schedule-cron">{t("schedule.schedule")}</Label>
          <Input
            id="schedule-cron"
            required
            placeholder="30 8 * * *"
            className="font-mono"
            value={config.schedule}
            onChange={(event) => set({ schedule: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t("schedule.scheduleHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="schedule-zone">{t("schedule.timeZone")}</Label>
          <Input
            id="schedule-zone"
            value={config.timeZone}
            onChange={(event) => set({ timeZone: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="schedule-prompt">{t("schedule.prompt")}</Label>
        <Textarea
          id="schedule-prompt"
          required
          rows={6}
          value={config.prompt}
          onChange={(event) => set({ prompt: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <div className="space-y-2">
          <Label htmlFor="schedule-timeout">{t("schedule.timeout")}</Label>
          <Input
            id="schedule-timeout"
            type="number"
            min={1}
            className="w-32"
            value={timeoutMinutes(config)}
            onChange={(event) =>
              setDraft({ ...draft, config: withTimeout(config, Number(event.target.value)) })
            }
          />
        </div>
        <Label className="flex items-center gap-2 pb-2">
          <Checkbox
            checked={config.paused}
            onCheckedChange={(checked) => set({ paused: checked === true })}
          />
          {t("schedule.paused")}
        </Label>
      </div>
      <Failure error={add.error ?? update.error} />
      <SaveButton pending={add.isPending || update.isPending} />
    </form>
  );
}
