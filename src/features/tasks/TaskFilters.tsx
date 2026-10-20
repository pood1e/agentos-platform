import { useQuery } from "@connectrpc/connect-query";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConsoleService } from "../../../gen/agentos/console/v1/console_service_pb.js";
import { ActivityState } from "../../../gen/agentos/console/v1/state_pb.js";
import { engineerName } from "../shared/engineers.js";
import { labelKey } from "../status/activity.js";

const states = [
  ActivityState.SUBMITTED,
  ActivityState.WORKING,
  ActivityState.AWAITING_APPROVAL,
  ActivityState.AWAITING_INPUT,
  ActivityState.SUCCEEDED,
  ActivityState.FAILED,
  ActivityState.REJECTED,
  ActivityState.CANCELED,
  ActivityState.UNOBSERVED,
];

export function TaskFilters({
  state,
  engineer,
  onChange,
}: {
  state?: ActivityState;
  engineer: string;
  onChange: (field: "state" | "engineer", value: string) => void;
}) {
  const { t } = useTranslation();
  const members = useQuery(ConsoleService.method.listEngineers, {}, { refetchInterval: 10_000 });
  return (
    <div className="flex gap-2 lg:flex-col" data-testid="task-filters">
      <Select
        value={state === undefined ? "all" : ActivityState[state]}
        onValueChange={(value) => onChange("state", value)}
      >
        <SelectTrigger
          aria-label={t("task.filterState")}
          className="h-8 min-w-0 flex-1 text-xs lg:flex-auto"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("task.allStates")}</SelectItem>
          {states.map((value) => (
            <SelectItem key={value} value={ActivityState[value]}>
              {t(labelKey(value))}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={engineer || "all"} onValueChange={(value) => onChange("engineer", value)}>
        <SelectTrigger
          aria-label={t("task.filterEngineer")}
          className="h-8 min-w-0 flex-1 text-xs lg:flex-auto"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("task.allEngineers")}</SelectItem>
          {members.data?.engineers.map((member) => (
            <SelectItem key={member.id} value={member.id}>
              {engineerName(member)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
