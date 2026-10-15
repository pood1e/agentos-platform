import { type CSSProperties, memo, useId } from "react";
import { packAsset, usePack } from "@/lib/pack";
import { cn } from "@/lib/utils";
import type { AvatarRig } from "../../../gen/agentos/console/v1/pack_pb.js";
import { roleLabel } from "./engineers.js";
import "./avatar.css";

type Posture = "working" | "waiting" | "idle";

interface Props {
  role?: string;
  state?: Posture;
  animated?: boolean;
  className?: string;
}

/** A role's avatar from the solution pack: a rigged cut-out, a whole image, or the platform glyph. */
export const Avatar = memo(function Avatar({
  role = "assistant",
  state = "idle",
  animated = false,
  className,
}: Props) {
  const presentation = usePack().roles.find((item) => item.role === role);
  const image = presentation?.avatar ? packAsset(presentation.avatar) : "";
  const motion = presentation?.rig?.motion;
  const style = {
    "--gesture-origin": presentation?.rig?.gestureOrigin || undefined,
    "--tool-origin": presentation?.rig?.toolOrigin || undefined,
    "--tool-angle": motion?.toolAngle || undefined,
    "--gesture-angle": motion?.gestureAngle || undefined,
    "--head-angle": motion?.headAngle || undefined,
    "--tool-duration": motion?.toolDuration || undefined,
    "--phase": motion?.phase || undefined,
  } as CSSProperties;
  return (
    <svg
      role="img"
      aria-label={roleLabel(role)}
      viewBox="0 0 256 342"
      width={256}
      height={342}
      className={cn("avatar block shrink-0", className)}
      style={style}
      data-testid="avatar"
      data-role={role}
      data-state={state}
      data-animated={animated}
    >
      <ellipse className="avatar-shadow" cx={128} cy={330} rx={72} ry={5} />
      <g className="avatar-breathe">
        {image && presentation?.rig ? (
          <Rigged image={image} rig={presentation.rig} />
        ) : image ? (
          <image href={image} width={256} height={342} />
        ) : (
          <Glyph />
        )}
      </g>
    </svg>
  );
});

function Rigged({ image, rig }: { image: string; rig: AvatarRig }) {
  const id = useId();
  return (
    <>
      <defs>
        <pattern
          id={`${id}-fur`}
          patternUnits="userSpaceOnUse"
          width="80"
          height="24"
          viewBox="90 262 80 24"
        >
          <use href={`#${id}-original`} />
        </pattern>
        <mask
          id={`${id}-silhouette`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="256"
          height="342"
          style={{ maskType: "alpha" }}
        >
          <use href={`#${id}-original`} />
        </mask>
        <linearGradient
          id={`${id}-neck`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1={rig.neck}
          x2="0"
          y2={rig.neck + 20}
        >
          <stop offset="0" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </linearGradient>
        <mask id={`${id}-head`} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="342">
          <path d={rig.head} fill={`url(#${id}-neck)`} />
          <path d={rig.gesture} fill="black" />
          <path d={rig.tool} fill="black" />
        </mask>
        <mask id={`${id}-body`} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="342">
          <rect x="0" y={rig.neck} width="256" height={342 - rig.neck} fill="white" />
          <path d={rig.gestureCut} fill="black" />
          <path d={rig.toolCut} fill="black" />
        </mask>
        <clipPath id={`${id}-gesture`}>
          <path d={rig.gesture} />
        </clipPath>
        <mask id={`${id}-tool`} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="342">
          <path d={rig.tool} fill="white" />
          <path d={rig.gesture} fill="black" />
        </mask>
        <image id={`${id}-original`} href={image} width={256} height={342} />
      </defs>
      <path d={rig.torso} fill={`url(#${id}-fur)`} mask={`url(#${id}-silhouette)`} />
      <use href={`#${id}-original`} mask={`url(#${id}-body)`} />
      <g className="avatar-head">
        <use href={`#${id}-original`} mask={`url(#${id}-head)`} />
      </g>
      <g className="avatar-tool">
        <use href={`#${id}-original`} mask={`url(#${id}-tool)`} />
      </g>
      <g className="avatar-gesture">
        <use href={`#${id}-original`} clipPath={`url(#${id}-gesture)`} />
      </g>
    </>
  );
}

/** Platform avatar for roles without a pack image. */
function Glyph() {
  return (
    <g className="text-muted-foreground" fill="currentColor">
      <rect x={58} y={86} width={140} height={112} rx={34} opacity={0.22} />
      <circle cx={102} cy={140} r={13} />
      <circle cx={154} cy={140} r={13} />
      <rect x={120} y={52} width={16} height={34} rx={8} opacity={0.4} />
      <rect x={70} y={212} width={116} height={100} rx={28} opacity={0.16} />
    </g>
  );
}
