import { clone, create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { RoleDefinitionSchema } from "../gen/agentos/console/v1/role_pb.js";
import { ResourceReferenceSchema } from "../gen/kagent/api/v1/common_pb.js";
import { roleCommands } from "../server/console/roles.js";
import { object } from "../server/read-model/decode/messages.js";
import { fakeKagent, testBindings } from "./harness.js";

it("rejects arbitrary embedding model names on both role creation and update", async () => {
  const { fake, clients } = fakeKagent();
  const commands = roleCommands(clients, "agentos", testBindings(fake), {
    modelConfig: "default-model-config",
    harness: "standard",
  });
  const source = fake.resources.get("modelconfigs", "knowledge-embedding");
  fake.resources.save(
    "modelconfigs",
    {
      ...source,
      metadata: {
        name: "custom-vector-model",
        annotations: { "agentos.dev/model-purpose": "embedding" },
      },
    },
    true,
  );
  const vector = create(ResourceReferenceSchema, {
    namespace: "agentos",
    name: "custom-vector-model",
  });
  const draft = create(RoleDefinitionSchema, {
    name: "service-health",
    displayName: "服务健康工程师",
    systemPrompt: "Inspect services.",
    modelConfig: vector,
  });
  try {
    expect(
      (await commands.configuration()).modelConfigs.map((model) => model.ref?.name),
    ).not.toContain(vector.name);
    await expect(commands.createRole(draft)).rejects.toMatchObject({ code: Code.InvalidArgument });
    draft.modelConfig = create(ResourceReferenceSchema, {
      namespace: "agentos",
      name: "default-model-config",
    });
    const { role: saved } = await commands.createRole(draft);
    const updated = clone(RoleDefinitionSchema, saved);
    updated.modelConfig = vector;
    await expect(commands.updateRole(updated)).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(object(fake.template("service-health").resource?.value?.spec).modelConfig).toMatchObject(
      { name: "default-model-config" },
    );
  } finally {
  }
});
