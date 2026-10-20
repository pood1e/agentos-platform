import { Check, Circle, CircleAlert, LoaderCircle, Pause } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { labelKey, type Tone, toneOf } from "./activity.js";

const appearances: Record<Tone, { className: string; color: string }> = {
  working: { className: "border-warning/25 bg-warning/10 text-warning", color: "var(--warning)" },
  waiting: { className: "border-info/25 bg-info/10 text-info", color: "var(--info)" },
  succeeded: {
    className: "border-success/25 bg-success/10 text-success",
    color: "var(--success)",
  },
  failed: {
    className: "border-destructive/25 bg-destructive/10 text-destructive",
    color: "var(--destructive)",
  },
  neutral: {
    className: "border-border bg-muted/50 text-muted-foreground",
    color: "var(--muted-foreground)",
  },
  unavailable: {
    className: "border-border bg-muted text-muted-foreground",
    color: "var(--muted-foreground)",
  },
};

const icons = {
  working: LoaderCircle,
  waiting: Pause,
  succeeded: Check,
  failed: CircleAlert,
  neutral: Circle,
  unavailable: CircleAlert,
} satisfies Record<Tone, unknown>;

export const appearance = (state: ActivityState) => appearances[toneOf(state)];

export function StatusIcon({ state, className }: { state: ActivityState; className?: string }) {
  const tone = toneOf(state);
  const Icon = icons[tone];
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-3", tone === "working" && "motion-safe:animate-spin", className)}
    />
  );
}

export function Status({
  state,
  children,
  onClick,
}: {
  state: ActivityState;
  children?: ReactNode;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  const badge = (
    <Badge
      variant="outline"
      className={cn("gap-1.5 font-medium", appearance(state).className)}
      data-tone={toneOf(state)}
    >
      <StatusIcon state={state} />
      {children ?? t(labelKey(state))}
    </Badge>
  );
  return onClick ? (
    <Button variant="ghost" size="xs" className="h-auto rounded-full p-0" onClick={onClick}>
      {badge}
    </Button>
  ) : (
    badge
  );
}
