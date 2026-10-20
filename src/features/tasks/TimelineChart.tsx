import { Scan } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type TimelineItem, Timeline as VisTimeline } from "vis-timeline/standalone";
import "vis-timeline/styles/vis-timeline-graph2d.css";
import "./timeline.css";
import { Button } from "@/components/ui/button";
import type { TaskDetail } from "../../../gen/agentos/console/v1/task_pb.js";
import { duration, time } from "../../lib/format.js";
import { engineerName } from "../shared/engineers.js";
import { labelKey } from "../status/activity.js";
import { appearance } from "../status/Status.js";
import type { DrawerTarget } from "./AgentDrawer.js";
import { timelineIntervals } from "./timeline.js";

export interface TimelineProps {
  detail: TaskDetail;
  onSelect: (target: DrawerTarget) => void;
}

const text = (value: string) => {
  const node = document.createElement("span");
  node.textContent = value;
  return node;
};

export function TimelineChart({ detail, onSelect }: TimelineProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<VisTimeline | null>(null);
  const fitted = useRef("");
  const intervals = useMemo(() => timelineIntervals(detail), [detail]);
  const [now, setNow] = useState(Date.now);
  const running = intervals.some((item) => item.open);
  useEffect(() => {
    if (!container.current) return;
    const timeline = new VisTimeline(container.current, [], [], {
      orientation: "top",
      stack: true,
      showCurrentTime: false,
      zoomKey: "ctrlKey",
      groupOrder: "order",
      dataAttributes: ["testid"],
      minHeight: 200,
      maxHeight: 600,
      format: {
        minorLabels: {
          millisecond: "SSS",
          second: "HH:mm:ss",
          minute: "HH:mm",
          hour: "HH:mm",
          weekday: "MM-DD",
          day: "MM-DD",
          week: "MM-DD",
          month: "MM",
          year: "YYYY",
        },
        majorLabels: {
          millisecond: "YYYY-MM-DD HH:mm:ss",
          second: "YYYY-MM-DD",
          minute: "YYYY-MM-DD",
          hour: "YYYY-MM-DD",
          weekday: "YYYY-MM",
          day: "YYYY-MM",
          week: "YYYY-MM",
          month: "YYYY",
          year: "",
        },
      },
    });
    chart.current = timeline;
    return () => {
      timeline.destroy();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const timeline = chart.current;
    if (!timeline) return;
    const items: (TimelineItem & { testid: string })[] = intervals.flatMap((item) => {
      if (item.startedAt === undefined) return [];
      const end = item.open ? Math.max(now, item.startedAt) : item.endedAt;
      const label = `${t(`task.timelineKinds.${item.kind}`)}${item.background ? ` · ${t("task.timelineBackground")}` : ""} · ${duration(item.startedAt, end)}`;
      return [
        {
          id: item.id,
          group: item.agentId,
          start: item.startedAt,
          end,
          type: end !== undefined && end > item.startedAt ? "range" : "point",
          content: text(label),
          title: `${label} · ${t(labelKey(item.state))} · ${time(item.startedAt)}`,
          style: `border-color: ${appearance(item.state).color}; border-style: ${item.open ? "dashed" : "solid"}`,
          testid: `timeline-${item.kind}`,
        },
      ];
    });
    timeline.setGroups(
      detail.participants.map((member, order) => ({
        id: member.id,
        content: text(engineerName(member)),
        order,
      })),
    );
    timeline.setItems(items);
    if (items.length && fitted.current !== detail.summary?.id) {
      timeline.fit({ animation: false });
      fitted.current = detail.summary?.id ?? "";
    }
    const select = ({ item: selected }: { item: string | number | null }) => {
      const item = intervals.find((item) => item.id === selected);
      if (item) onSelect(item.target);
    };
    timeline.on("click", select);
    return () => timeline.off("click", select);
  }, [detail, intervals, now, t, onSelect]);
  return (
    <section
      aria-label={t("task.timeline")}
      data-testid="task-timeline"
      className="task-timeline min-h-0 min-w-0 flex-1 overflow-auto rounded-xl border bg-card p-3"
    >
      <div className="mb-2 flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => chart.current?.fit({ animation: false })}>
          <Scan />
          {t("task.fitTimeline")}
        </Button>
      </div>
      <div ref={container} />
      {intervals
        .filter((item) => item.startedAt === undefined)
        .map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            size="sm"
            onClick={() => onSelect(item.target)}
            className="mt-2"
          >
            {t(`task.timelineKinds.${item.kind}`)} · {t("status.unreported")}
          </Button>
        ))}
    </section>
  );
}
