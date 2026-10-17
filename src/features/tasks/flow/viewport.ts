import { getViewportForBounds, type Rect } from "@xyflow/react";

export const zoomLimits = { minZoom: 0.01, maxZoom: 2 };
export const fitPadding = 0.12;

export function diagramBounds(canvas: HTMLElement | null, nodes: Rect): Rect {
  const boxes = [
    nodes,
    ...Array.from(
      canvas?.querySelectorAll<SVGGraphicsElement>(".react-flow__edge-path") ?? [],
      (path) => path.getBBox(),
    ),
  ];
  const x = Math.min(...boxes.map((box) => box.x)),
    y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  };
}

export function graphViewport(bounds: Rect, width: number, height: number, maxZoom = 2) {
  return getViewportForBounds(bounds, width, height, zoomLimits.minZoom, maxZoom, fitPadding);
}
