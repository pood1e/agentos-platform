import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { MessageSchema, Role, TaskSchema } from "../gen/a2a_pb.js";
import { ApprovalToolSchema, InteractionSchema } from "../gen/agentos/console/v1/task_pb.js";
import { EnvironmentConnectionSchema } from "../gen/agentos/governance/v1/change_pb.js";
import { changeRequest, environmentFor } from "../server/operations/requests.js";
import { ingest } from "../server/read-model/entry.js";

const canonical = "env-sim-kubernetes_resources_create_or_update";
it.each([
  canonical,
  `env-sim-kubernetes-simulation-changes.${canonical}`,
  `mcp__env-sim-kubernetes-simulation-changes__${canonical}`,
])("correlates native approval %s with the environment's canonical tool", (name) => {
  const args = {
    manifest: "apiVersion: v1\nkind: ConfigMap",
    nested: { values: [1, "<literal>"] },
  };
  const connections = [create(EnvironmentConnectionSchema, { environment: { name: "env-sim" } })];
  expect(environmentFor(connections, name)).toBe(connections[0]);
  const task = create(TaskSchema, {
    id: "task",
    contextId: "session",
    history: [
      create(MessageSchema, {
        role: Role.USER,
        parts: [{ content: { case: "text", value: "Verify a disposable operation" } }],
      }),
    ],
  });
  const request = changeRequest(
    ingest(task, "agentos/simulation"),
    create(InteractionSchema, { requestId: "pause", explanation: "Validate the execution path" }),
    create(ApprovalToolSchema, {
      id: "approval",
      callId: "call",
      name,
      args: fromJson(ValueSchema, args),
    }),
  );
  expect(request.engineer).toBe("simulation");
  expect(request.tool).toMatchObject({ name: canonical, args, id: "approval", callId: "call" });
});
