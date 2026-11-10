import { ControlButton, Controls, type Rect, useReactFlow, useStore } from "@xyflow/react";
import { Maximize } from "lucide-react";
import { useEffect } from "react";

export function FitGraphOnResize({ padding = 0.15, bounds }: { padding?: number; bounds?: Rect }) {
  const { fitView, fitBounds, viewportInitialized } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    if (!viewportInitialized || width <= 0 || height <= 0) return;
    if (bounds) void fitBounds(bounds, { padding });
    else void fitView({ maxZoom: 1.2, padding });
  }, [fitView, fitBounds, width, height, padding, bounds, viewportInitialized]);
  return null;
}

export function GraphControls({ bounds, label }: { bounds?: Rect; label: string }) {
  const { fitBounds } = useReactFlow();
  return (
    <Controls showInteractive={false} showFitView={!bounds}>
      {bounds && (
        <ControlButton
          title={label}
          aria-label={label}
          onClick={() => void fitBounds(bounds, { padding: 0.05 })}
        >
          <Maximize size={14} />
        </ControlButton>
      )}
    </Controls>
  );
}
