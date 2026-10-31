import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { RoleDefinitionSchema } from "../gen/agentos/console/v1/role_pb.js";
import { AgentTemplateSchema } from "../gen/kagent/api/v1/agent_templates_pb.js";
import { roleCommands } from "../server/console/roles.js";
import { fakeKagent, testBindings } from "./harness.js";

it("separates native workflows from editable roles", async () => {
  const { fake, clients } = fakeKagent();
  fake.templates.set(
    "nightly-workflow",
    create(AgentTemplateSchema, {
      ref: { namespace: "agentos", name: "nightly-workflow" },
      resource: {
        value: {
          metadata: { name: "nightly-workflow", namespace: "agentos" },
          spec: {
            description: "Nightly workflow",
            workflowFrom: { name: "graphs", key: "nightly.yaml" },
          },
        },
      },
    }),
  );
  const commands = roleCommands(clients, "agentos", testBindings(fake), {
    modelConfig: "default-model-config",
    harness: "standard",
  });
  const configuration = await commands.configuration();
  expect(configuration.roles.map((role) => role.name)).not.toContain("nightly-workflow");
  expect(configuration.roles.length).toBeGreaterThan(0);
  await expect(
    commands.updateRole(
      create(RoleDefinitionSchema, {
        name: "nightly-workflow",
        displayName: "Overwrite workflow",
        systemPrompt: "Replace the workflow.",
      }),
    ),
  ).rejects.toMatchObject({ code: Code.NotFound });
  expect(fake.template("nightly-workflow").resource?.value?.spec).toMatchObject({
    workflowFrom: { name: "graphs", key: "nightly.yaml" },
  });
});
