import { clone, create } from "@bufbuild/protobuf";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import {
  type ScheduledRun,
  ScheduledRunConfigSchema,
} from "../../../gen/kagent/api/v1/scheduled_runs_pb.js";
import { useAccess } from "../../lib/access.js";
import { automationClient, consoleClient } from "../../lib/console.js";
import { SaveButton } from "../management/ResourceDialog.js";
import { Failure } from "../management/ResourcePage.js";
import { engineerName } from "../shared/engineers.js";

export function ScheduleEditor({
  schedule,
  onSaved,
}: {
  schedule?: ScheduledRun;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const access = useAccess();
  const [requestId] = useState(() => crypto.randomUUID());
  const [agent, setAgent] = useState(schedule?.agent?.name ?? "");
  const [config, setConfig] = useState(() =>
    schedule?.config
      ? clone(ScheduledRunConfigSchema, schedule.config)
      : create(ScheduledRunConfigSchema, {
          schedule: "0 9 * * *",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          paused: true,
          executionTimeout: { seconds: 900n },
        }),
  );
  const targets = useQuery({
    queryKey: ["automation-targets"],
    queryFn: ({ signal }) => consoleClient.listEngineers({}, { signal }),
  });
  const save = useMutation({
    mutationFn: async () => {
      if (schedule)
        await automationClient.updateScheduledRun({
          scheduledRunId: schedule.id,
          etag: schedule.etag,
          config,
        });
      else
        await automationClient.createScheduledRun({
          requestId,
          config,
          agent: { namespace: access.data?.workspace ?? "", name: agent },
        });
    },
    onSuccess: onSaved,
  });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="schedule-name">{t("automation.name")}</Label>
        <Input
          id="schedule-name"
          value={config.name}
          required
          maxLength={200}
          onChange={(event) => setConfig({ ...config, name: event.target.value })}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="schedule-agent">{t("automation.agent")}</Label>
        <Select value={agent} onValueChange={setAgent} disabled={!!schedule} required>
          <SelectTrigger id="schedule-agent">
            <SelectValue placeholder={t("automation.selectAgent")} />
          </SelectTrigger>
          <SelectContent>
            {targets.data?.engineers.map((target) => (
              <SelectItem key={target.id} value={target.id.split("/").at(-1) ?? target.id}>
                {engineerName(target)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Failure error={targets.error} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="schedule-cron">{t("automation.cron")}</Label>
          <Input
            id="schedule-cron"
            value={config.schedule}
            required
            maxLength={256}
            placeholder="0 9 * * *"
            className="font-mono"
            onChange={(event) => setConfig({ ...config, schedule: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t("automation.cronHint")}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="schedule-zone">{t("automation.timeZone")}</Label>
          <Input
            id="schedule-zone"
            value={config.timeZone}
            required
            maxLength={253}
            placeholder="Asia/Shanghai"
            onChange={(event) => setConfig({ ...config, timeZone: event.target.value })}
          />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="schedule-prompt">{t("automation.prompt")}</Label>
        <Textarea
          id="schedule-prompt"
          value={config.prompt}
          required
          rows={6}
          maxLength={32768}
          onChange={(event) => setConfig({ ...config, prompt: event.target.value })}
        />
      </div>
      <Label className="flex items-center gap-2" htmlFor="schedule-enabled">
        <Checkbox
          id="schedule-enabled"
          checked={!config.paused}
          onCheckedChange={(checked) => setConfig({ ...config, paused: checked !== true })}
        />
        {t("automation.enabled")}
      </Label>
      <p className="text-sm text-muted-foreground">{t("automation.identityHint")}</p>
      <Failure error={save.error} />
      <SaveButton pending={save.isPending || !agent || !access.data} />
    </form>
  );
}
