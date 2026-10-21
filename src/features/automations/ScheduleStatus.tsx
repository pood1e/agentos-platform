import { CircleCheck, Pause } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

export function ScheduleStatus({ paused }: { paused?: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className={
        paused
          ? "text-muted-foreground"
          : "border-emerald-600/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      }
    >
      {paused ? <Pause className="size-3" /> : <CircleCheck className="size-3" />}
      {t(paused ? "automation.paused" : "automation.active")}
    </Badge>
  );
}
