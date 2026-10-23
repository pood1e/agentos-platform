import { create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { McpRequestSchema } from "../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { platformToolAuthorization } from "../server/authorization/platform-tools.js";
import type { ExecutionRuntime } from "../server/authorization/runtime.js";
import type { WorkloadIdentity } from "../server/authorization/workloads.js";
import { environment, testBindings } from "./harness.js";

it("intersects the verified Actor, service binding and original user's write ceiling", async () => {
  const { fake, sync } = environment();
  const session = create(SessionSchema, { id: "actor-session" });
  const actor = vi.fn(async () => session);
  let write = false;
  const execution = {
    actor,
    registry: { resolve: async () => ({ write }) },
    agentRole: async () => ({
      engineer: "remediation",
      role: { tools: [{ server: "remediation-tools", tools: ["k8s_apply_manifest"] }] },
    }),
  } as unknown as ExecutionRuntime;
  const workloads = {
    config: { mcpAudience: "http://mcp.test" },
    controller: vi.fn(async () => {
      throw new Error("Invalid controller");
    }),
  } as unknown as WorkloadIdentity;
  const policy = platformToolAuthorization(execution, workloads, testBindings(fake));
  const request = create(McpRequestSchema, {
    method: "tools/call",
    serviceNames: ["remediation-tools"],
    headers: [{ key: "x-substrate-actor-token", value: new TextEncoder().encode("Bearer actor") }],
    mcpRequest: new TextEncoder().encode(
      JSON.stringify({ name: "k8s_apply_manifest", arguments: {} }),
    ),
  });
  const check = (next = request) => policy.checkRequest(next, {} as never);
  try {
    expect((await check()).result?.case).toBe("error");
    expect(actor).toHaveBeenLastCalledWith(
      { "x-substrate-actor-token": "Bearer actor" },
      "http://mcp.test",
    );
    write = true;
    expect((await check()).result?.case).toBe("pass");
    expect((await check({ ...request, serviceNames: ["unbound-service"] })).result?.case).toBe(
      "error",
    );
    expect(
      (await check({ ...request, serviceNames: ["remediation-tools", "unbound-service"] })).result
        ?.case,
    ).toBe("error");
    expect((await check({ ...request, headers: [] })).result?.case).toBe("error");
    actor.mockRejectedValueOnce(new Error("Stale Actor UID"));
    expect((await check()).result?.case).toBe("error");
  } finally {
    sync.close();
  }
});
