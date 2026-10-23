import { readFileSync } from "node:fs";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import {
  ModelAuthorizationSchema,
  WorkloadAuthenticationSchema,
} from "../gen/agentos/authorization/v1/workload_pb.js";
import { modelAuthorization } from "../server/authorization/models.js";
import type { ExecutionRuntime } from "../server/authorization/runtime.js";
import { workloadIdentity } from "../server/authorization/workloads.js";
import { object } from "../server/read-model/decode/messages.js";
import { environment } from "./harness.js";

it("checks the Actor audience, execution binding, current model and API for every model request", async () => {
  const { clients, sync } = environment();
  const trust = fromJsonString(
    WorkloadAuthenticationSchema,
    readFileSync("tests/fixtures/identity/workloads.json", "utf8"),
  );
  const { modelConfig } = await clients.models.getModelConfig({
    ref: { namespace: "agentos", name: "default-model-config" },
  });
  const model = String(object(modelConfig?.resource?.value?.spec).model);
  const resolve = vi.fn(async () => ({}));
  const actor = vi.fn(async () => ({ id: "session" }));
  const execution = {
    actor,
    registry: { resolve },
    agentRole: async () => ({ role: { modelConfig: { name: "default-model-config" } } }),
  } as unknown as ExecutionRuntime;
  const authorize = modelAuthorization(clients, execution, workloadIdentity(trust), "agentos");
  const headers = { "x-substrate-actor-token": "Bearer actor" };
  const request = create(ModelAuthorizationSchema, {
    path: "/v1/chat/completions",
    method: "POST",
    model,
  });
  try {
    await authorize(request, headers);
    await authorize({ ...request, path: "/v1/messages" }, headers);
    await authorize({ ...request, path: "/v1/messages/count_tokens" }, headers);
    expect(actor).toHaveBeenLastCalledWith(headers, trust.modelAudience);
    await expect(authorize({ ...request, model: "other-model" }, headers)).rejects.toThrow();
    await expect(authorize({ ...request, path: "/v1/files" }, headers)).rejects.toThrow();
    await expect(authorize({ ...request, method: "DELETE" }, headers)).rejects.toThrow();
    resolve.mockRejectedValueOnce(new Error("Execution revoked"));
    await expect(authorize(request, headers)).rejects.toThrow("revoked");
    const controller = { authorization: "Bearer controller" };
    await expect(authorize(request, controller)).rejects.toThrow();
  } finally {
    sync.close();
  }
});
