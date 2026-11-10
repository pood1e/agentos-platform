import { Code } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { object, text } from "../shared/json.js";
import { initialDocument } from "../src/features/workflows/document.js";
import { managementEnvironment } from "./management-harness.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
beforeEach(async () => {
  env = await managementEnvironment();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.close();
});

async function history() {
  const documents = env.dependencies.documents;
  const names: string[] = [];
  for (let i = 0; i < 14; i++) {
    const document = `${initialDocument}# revision ${i}\n`;
    await documents.stage("flow", document);
    const { name } = documents.source("flow", document);
    names.push(name);
    const value = env.fake.resources.get("configmaps", name);
    const old = new Date(Date.now() - 172_800_000 + i * 1000).toISOString();
    value.metadata = {
      ...object(value.metadata),
      creationTimestamp: old,
      annotations: { "agentos.dev/workflow-last-used": old },
    };
    env.fake.resources.save("configmaps", value, false);
  }
  return names;
}
const remains = () =>
  new Set(env.fake.resources.list("configmaps").map((item) => text(object(item.metadata).name)));

const promptDocument = (name: string) =>
  initialDocument.replace(
    "type: cel\n        output: input",
    `type: llm\n        model: template:model\n        instruction_from: {configMap: {name: ${name}, key: workflow.yaml}}`,
  );

it("retains namespace-wide live references and prompt sources hidden from a user's catalog", async () => {
  const names = await history();
  const agentList = vi
    .spyOn(env.clients.agents, "listAgents")
    .mockResolvedValue({ agents: [], $typeName: "kagent.api.v1.ListAgentsResponse" });
  env.fake.resources.save(
    "agents",
    {
      metadata: { name: "hidden" },
      spec: {
        template: { inline: { systemPromptFrom: { name: names[0], key: "workflow.yaml" } } },
      },
    },
    true,
  );
  env.fake.resources.save(
    "configmaps",
    { metadata: { name: "preset-active" }, data: { "workflow.yaml": promptDocument(names[1]) } },
    true,
  );
  env.fake.resources.save(
    "agents",
    {
      metadata: { name: "running" },
      spec: {
        template: {
          inline: {
            workflowFrom: { name: "preset-active", key: "workflow.yaml" },
            outputSchemaFrom: { name: names[2], key: "schema.json" },
          },
        },
      },
    },
    true,
  );
  await env.dependencies.documents.prune("flow", initialDocument);
  expect(agentList).not.toHaveBeenCalled();
  expect(remains().has(names[0])).toBe(true);
  expect(remains().has(names[1])).toBe(true);
  expect(remains().has(names[2])).toBe(true);
  expect(remains().has(names[3])).toBe(false);
  for (const name of names.slice(4)) expect(remains().has(name)).toBe(true);
});

it("protects a reused historical source with a versioned metadata touch", async () => {
  const names = await history();
  await env.dependencies.documents.stage("flow", `${initialDocument}# revision 0\n`);
  await env.dependencies.documents.prune("flow", initialDocument);
  expect(remains().has(names[0])).toBe(true);
  expect(remains().has(names[1])).toBe(false);
});

it("retains candidates' prompt dependencies and stops GC when reference discovery fails", async () => {
  const names = await history();
  const candidate = promptDocument(names[0]);
  await env.dependencies.documents.prune("flow", candidate);
  expect(remains().has(names[0])).toBe(true);
  env.fake.resources.save(
    "agents",
    {
      metadata: { name: "missing-source" },
      spec: { template: { inline: { workflowFrom: { name: "missing", key: "workflow.yaml" } } } },
    },
    true,
  );
  const before = remains();
  await expect(env.dependencies.documents.prune("flow", initialDocument)).rejects.toMatchObject({
    code: Code.NotFound,
  });
  expect(remains()).toEqual(before);
});
