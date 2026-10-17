import {
  CheckCheck,
  CircleCheck,
  CircleDashed,
  CircleX,
  FileClock,
  LoaderCircle,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CandidateState } from "../../../gen/agentos/evaluation/v1/evaluation_pb.js";

const states = {
  [CandidateState.UNSPECIFIED]: {
    name: "unknown",
    icon: CircleDashed,
    color: "text-muted-foreground",
  },
  [CandidateState.DRAFT]: { name: "draft", icon: FileClock, color: "text-muted-foreground" },
  [CandidateState.RUNNING]: {
    name: "running",
    icon: LoaderCircle,
    color: "animate-spin text-blue-500",
  },
  [CandidateState.PASSED]: { name: "passed", icon: CircleCheck, color: "text-emerald-500" },
  [CandidateState.FAILED]: { name: "failed", icon: CircleX, color: "text-destructive" },
  [CandidateState.STALE]: { name: "stale", icon: CircleDashed, color: "text-amber-500" },
  [CandidateState.PUBLISHED]: { name: "published", icon: CheckCheck, color: "text-emerald-500" },
  [CandidateState.PUBLISHING]: {
    name: "publishing",
    icon: Upload,
    color: "animate-pulse text-blue-500",
  },
};

export function CandidateStatus({ state }: { state: CandidateState }) {
  const { t } = useTranslation(),
    { name, icon: Icon, color } = states[state] ?? states[CandidateState.UNSPECIFIED];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={t(`evaluation.states.${name}`)} className="inline-flex">
          <Icon className={`size-4 ${color}`} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{t(`evaluation.states.${name}`)}</TooltipContent>
    </Tooltip>
  );
}

export function useCandidateName() {
  const { t } = useTranslation();
  return (name: string) => {
    const [operation, subject] = name.split(":", 2);
    return `${t(`evaluation.operations.${operation}`, { defaultValue: operation })}${subject ? ` · ${subject}` : ""}`;
  };
}
