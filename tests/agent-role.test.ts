import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { AgentTemplateSchema } from "../gen/kagent/api/v1/agent_templates_pb.js";
import { AgentSchema } from "../gen/kagent/api/v1/agents_pb.js";
import { ResourceReferenceSchema } from "../gen/kagent/api/v1/common_pb.js";
import { agentInfo } from "../server/read-model/agents.js";
import { agentSummaries } from "../server/read-model/views/agents.js";
import { agentName } from "../src/features/shared/agents.js";

it("resolves native template references independently of business role labels", () => {
  const agent = create(AgentSchema, {
    ref: { namespace: "workspace", name: "night-shift" },
    resource: {
      value: {
        metadata: { labels: { "agentos.dev/role": "coordinator" } },
        spec: { template: { ref: { name: "supervisor" } } },
      },
    },
  });
  expect(agentInfo(agent).templateName).toBe("supervisor");
  if (!agent.resource?.value) throw new Error("Agent fixture missing");
  agent.resource.value.metadata = { labels: { "agentos.dev/role": "assistant" } };
  expect(agentInfo(agent).templateName).toBe("supervisor");
});

it("includes workflow Agents in the generic directory with their own execution identity", () => {
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
  expect(info).toMatchObject({
    id: "workspace/nightly-runner",
    templateName: "nightly",
    workflow: true,
  });
  expect(agentSummaries([info], new Map())).toMatchObject([
    { id: "workspace/nightly-runner", template: { namespace: "workspace", name: "nightly" } },
  ]);
  if (!workflow.resource?.value) throw new Error("Agent fixture missing");
  workflow.resource.value.spec = {
    template: { inline: { workflowFrom: { name: "graphs", key: "inline.yaml" } } },
  };
  expect(agentInfo(workflow).workflow).toBe(true);
});

it("names shared-template Agents by their own identity", () => {
  expect(
    agentName({
      id: "workspace/night-shift",
      name: "",
      template: create(ResourceReferenceSchema, { namespace: "workspace", name: "coordinator" }),
    }),
  ).toBe("night-shift");
  expect(
    agentName({
      id: "workspace/night-shift",
      name: "Night shift",
      template: create(ResourceReferenceSchema, { namespace: "workspace", name: "coordinator" }),
    }),
  ).toBe("Night shift");
});
