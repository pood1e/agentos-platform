import { active, awaiting } from "../../status/activity.js";
import type { FlowConnection } from "./collaboration-flow.js";
import type { CollaborationStep } from "./sequence.js";

export interface ConnectionBundle {
  id: string;
  source: string;
  target: string;
  records: FlowConnection[];
}

/** Rendering shares one curve per instance pair; native events remain intact. */
export function bundleConnections(connections: FlowConnection[]) {
  const bundles = new Map<string, ConnectionBundle>();
  for (const connection of connections) {
    const id = JSON.stringify([connection.source, connection.target].sort());
    const bundle = bundles.get(id);
    if (bundle) bundle.records.push(connection);
    else
      bundles.set(id, {
        id,
        source: connection.source,
        target: connection.target,
        records: [connection],
      });
  }
  return [...bundles.values()];
}

export function connectionSteps(bundle: ConnectionBundle) {
  return [...new Map(bundle.records.map(({ step }) => [step.link.id, step])).values()];
}

export function currentStep(steps: CollaborationStep[]) {
  return (
    steps.findLast(({ link }) => active(link.state)) ??
    steps.findLast(({ link }) => awaiting(link.state)) ??
    steps.at(-1)
  );
}
