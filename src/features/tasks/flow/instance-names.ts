import type { Engineer } from "../../../../gen/agentos/console/v1/engineer_pb.js";
import { engineerName } from "../../shared/engineers.js";
import type { FlowActivity } from "./collaboration-flow.js";

export function instanceNames(activities: FlowActivity[], engineers: Engineer[]) {
  const names = new Map(
    activities
      .filter((activity) => activity.kind === "engineer")
      .map((activity) => {
        const engineer = engineers.find((item) => item.id === activity.agentId);
        return [
          activity.id,
          activity.name || (engineer ? engineerName(engineer) : activity.agentId),
        ] as const;
      }),
  );
  const result = new Map<string, string>();
  for (const [id, name] of names) {
    const peers = [...names]
      .filter(([, other]) => other === name)
      .map(([id]) => id)
      .sort();
    result.set(id, peers.length > 1 ? `${name} · ${peers.indexOf(id) + 1}` : name);
  }
  return result;
}
