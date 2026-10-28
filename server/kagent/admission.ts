import type { JsonObject } from "@bufbuild/protobuf";
import type { ResourceReference } from "../../gen/kagent/api/v1/common_pb.js";
import type { KagentClients } from "./clients.js";

/** Native compilers validate the complete candidate against live dependencies. */
export async function validateAgent(
  clients: KagentClients,
  ref: Pick<ResourceReference, "name" | "namespace">,
  spec: JsonObject,
) {
  await clients.agents.validateAgent(
    {
      ref,
      resource: {
        apiVersion: "api.kagent.dev/v1alpha3",
        kind: "Agent",
        value: { apiVersion: "api.kagent.dev/v1alpha3", kind: "Agent", metadata: ref, spec },
      },
    },
    { timeoutMs: 30_000 },
  );
}
