import type { JsonObject } from "@bufbuild/protobuf";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import { kagentApiVersion } from "../../shared/kagent-resources.js";
import type { KagentClients } from "./clients.js";
import { resource } from "./resources.js";

/** Native compilers validate the complete candidate against live dependencies. */
export async function validateAgent(
  clients: KagentClients,
  ref: Pick<ResourceReference, "name" | "namespace">,
  spec: JsonObject,
) {
  await clients.agents.validateAgent(
    {
      ref,
      resource: resource({
        apiVersion: kagentApiVersion,
        kind: "Agent",
        metadata: { name: ref.name, namespace: ref.namespace },
        spec,
      }),
    },
    { timeoutMs: 30_000 },
  );
}
