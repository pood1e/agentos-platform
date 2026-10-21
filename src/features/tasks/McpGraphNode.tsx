import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { Bot } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ActivityState } from "../../../gen/agentos/execution/v1/state_pb.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { labelKey } from "../status/activity.js";
import { appearance, StatusIcon } from "../status/Status.js";

export type McpGraphNode = Node<
  {
    kind: "agent" | "server";
    title: string;
    subtitle: string;
    server?: string;
    state?: ActivityState;
    selected: boolean;
    vertical: boolean;
  },
  "execution"
>;

export const McpNode = memo(function McpNode({ data }: NodeProps<McpGraphNode>) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`mcp-graph-${data.kind}`}
      data-mcp-server={data.server}
      className={cn(
        "flex h-full items-center gap-3 rounded-xl border bg-card p-4 shadow-xs",
        data.selected && "ring-2 ring-primary/40",
      )}
    >
      {data.kind !== "agent" && (
        <Handle
          type="target"
          position={data.vertical ? Position.Top : Position.Left}
          isConnectable={false}
        />
      )}
      <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {data.kind === "server" ? (
          <ToolIcon
            name=""
            server={data.server}
            className="size-11 border-0 bg-transparent [&_img]:size-8"
          />
        ) : (
          <Bot className="size-5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm font-semibold" title={data.title}>
          {data.title}
        </strong>
        <p className="mt-1 truncate text-xs text-muted-foreground">{data.subtitle}</p>
        {data.state !== undefined && (
          <p
            className="mt-2 flex items-center gap-1 text-[11px]"
            style={{ color: appearance(data.state).color }}
          >
            <StatusIcon state={data.state} className="size-3" />
            {t(labelKey(data.state))}
          </p>
        )}
      </div>
      {data.kind === "agent" && (
        <Handle
          type="source"
          position={data.vertical ? Position.Bottom : Position.Right}
          isConnectable={false}
        />
      )}
    </div>
  );
});
