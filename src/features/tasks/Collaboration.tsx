import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import type { GraphProps } from "./Graph.js";

const Graph = lazy(() => import("./Graph.js").then((module) => ({ default: module.Graph })));

export function Collaboration(props: GraphProps) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("graph.title")}
      className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card"
      data-testid="collaboration-graph"
    >
      <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
        <Graph {...props} />
      </Suspense>
    </section>
  );
}
