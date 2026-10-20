import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CollaborationEdge = Edge<
  {
    label: string;
    description: string;
    color: string;
    selected: boolean;
    onCall: () => void;
    path: string;
    labelPosition: { x: number; y: number };
  },
  "collaboration"
>;

export const GraphEdge = memo(function GraphEdge(props: EdgeProps<CollaborationEdge>) {
  const data = props.data;
  if (!data) return null;
  const { x, y } = data.labelPosition;
  return (
    <>
      <BaseEdge
        id={props.id}
        path={data.path}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={8}
      />
      {data && (
        <EdgeLabelRenderer>
          <Button
            variant="ghost"
            size="sm"
            aria-label={data.description}
            onClick={data.onCall}
            className={cn(
              "nodrag nopan pointer-events-auto absolute z-10 h-auto min-h-5 max-w-[124px] whitespace-normal rounded-sm bg-background/95 px-1.5 py-0 text-center text-[10px] font-normal leading-5 disabled:opacity-100",
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
