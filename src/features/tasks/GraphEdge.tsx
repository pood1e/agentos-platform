import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
} from "@xyflow/react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CollaborationEdge = Edge<
  {
    label: string;
    description: string;
    color: string;
    selected: boolean;
    callKey?: string;
    onCall: (id: string) => void;
  },
  "collaboration"
>;

export const GraphEdge = memo(function GraphEdge(props: EdgeProps<CollaborationEdge>) {
  const [path, x, y] = getBezierPath({ ...props, curvature: 0.4 });
  const data = props.data;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={8}
      />
      {data && (
        <EdgeLabelRenderer>
          <Button
            variant="ghost"
            size="sm"
            disabled={!data.callKey}
            aria-label={data.description}
            onClick={() => {
              if (data.callKey) data.onCall(data.callKey);
            }}
            className={cn(
              "nodrag nopan pointer-events-auto absolute h-5 rounded-sm bg-background/95 px-1.5 text-[10px] font-normal disabled:opacity-100",
              data.selected && "ring-1 ring-primary/30",
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
              color: data.color,
            }}
          >
            {data.label}
          </Button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
