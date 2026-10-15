import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useConnection } from "../lib/connection.js";

const labels = { live: "status.live", connecting: "status.connecting" } as const;

export function Connection() {
  const { t } = useTranslation();
  const { state, error } = useConnection();
  const label = t(state === "failed" ? error : labels[state]);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-testid="connection"
      data-state={
        state === "live" ? "connected" : state === "failed" ? "disconnected" : "connecting"
      }
      className={cn(
        "mx-1 size-1.5 shrink-0 rounded-full",
        state === "live"
          ? "bg-success"
          : state === "failed"
            ? "bg-destructive"
            : "bg-muted-foreground",
      )}
    />
  );
}
