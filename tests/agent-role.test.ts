import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { AgentSchema } from "../gen/kagent/api/v1alpha1/agents_pb.js";
import { agentInfo } from "../server/read-model/agents.js";

it("derives role identity from the assigned template independently of labels", () => {
  const agent = create(AgentSchema, {
    ref: { namespace: "workspace", name: "night-shift" },
    resource: {
      value: {
        metadata: { labels: { "agentos.dev/role": "coordinator" } },
        spec: { templateRef: { name: "supervisor" } },
      },
    },
  });
  expect(agentInfo(agent).role).toBe("supervisor");
  if (!agent.resource?.value) throw new Error("Agent fixture missing");
  agent.resource.value.metadata = { labels: { "agentos.dev/role": "assistant" } };
  expect(agentInfo(agent).role).toBe("supervisor");
});
