import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { AgentTemplateSchema } from "../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentSchema } from "../gen/kagent/api/v1/agents_pb.js";
import { agentInfo } from "../server/read-model/agents.js";
import { engineers } from "../server/read-model/views/engineers.js";

it("derives role identity from the assigned template independently of labels", () => {
  const agent = create(AgentSchema, {
    ref: { namespace: "workspace", name: "night-shift" },
    resource: {
      value: {
        metadata: { labels: { "agentos.dev/role": "coordinator" } },
        spec: { template: { ref: { name: "supervisor" } } },
      },
    },
  });
  expect(agentInfo(agent).role).toBe("supervisor");
  if (!agent.resource?.value) throw new Error("Agent fixture missing");
  agent.resource.value.metadata = { labels: { "agentos.dev/role": "assistant" } };
  expect(agentInfo(agent).role).toBe("supervisor");
});

it("keeps workflow runtimes outside the engineer roster while preserving their identity", () => {
  const template = create(AgentTemplateSchema, {
    ref: { namespace: "workspace", name: "nightly" },
    resource: { value: { spec: { workflowFrom: { name: "graphs", key: "nightly.yaml" } } } },
  });
  const workflow = create(AgentSchema, {
    ref: { namespace: "workspace", name: "nightly-runner" },
    resource: { value: { spec: { template: { ref: { name: "nightly" } } } } },
  });
  const templates = new Map([["workspace/nightly", template]]);
  const info = agentInfo(workflow, templates);
  expect(info).toMatchObject({ id: "workspace/nightly-runner", role: "", workflow: true });
  expect(engineers([info], new Map())).toEqual([]);
  if (!workflow.resource?.value) throw new Error("Agent fixture missing");
  workflow.resource.value.spec = {
    template: { inline: { workflowFrom: { name: "graphs", key: "inline.yaml" } } },
  };
  expect(agentInfo(workflow).workflow).toBe(true);
});
