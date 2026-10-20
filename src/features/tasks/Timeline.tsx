import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { TimelineProps } from "./TimelineChart.js";

const Chart = lazy(() =>
  import("./TimelineChart.js").then((module) => ({ default: module.TimelineChart })),
);

export function Timeline(props: TimelineProps) {
  return (
    <Suspense fallback={<Skeleton className="min-h-48 flex-1" />}>
      <Chart {...props} />
    </Suspense>
  );
}
