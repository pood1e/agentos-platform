import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it, vi } from "vitest";
import { ExtMcp } from "../gen/agentgateway/dev/ext_mcp/ext_mcp_pb.js";
import { EnvironmentSchema, Governance } from "../gen/agentos/governance/v1/change_pb.js";
import { changeGuardrails } from "../server/change-control/ext-mcp.js";
import { changeControl } from "../server/change-control/service.js";
import { fixtureCatalog } from "./harness.js";

const claim = vi.fn(async () => {
  throw new Error("A prepared and approved change is required");
});
const control = changeControl(
  { claim } as never,
  {} as never,
  create(EnvironmentSchema, { name: "lab-real", governance: Governance.APPROVAL }),
  fixtureCatalog(),
);
const client = createClient(
  ExtMcp,
  createRouterTransport((router) => router.service(ExtMcp, changeGuardrails(control))),
);
const call = (name: string, project = "netbox", engineer = "asset") =>
  client.checkRequest({
    method: "tools/call",
    serviceNames: ["netbox-write"],
    metadataContext: { project, engineer },
    mcpRequest: new TextEncoder().encode(
      JSON.stringify({ name, arguments: { body: { name: "Server", slug: "server" } } }),
    ),
  });

describe("environment MCP project identity", () => {
  it("authorizes a declared CMDB write through an aggregated OpenAPI backend", async () => {
    claim.mockClear();
    expect((await call("dcim_device_roles_create")).result.case).toBe("pass");
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects unknown tools and missing trusted project or engineer metadata", async () => {
    for (const request of [
      call("unknown_tool"),
      call("dcim_device_roles_create", ""),
      call("dcim_device_roles_create", "netbox", ""),
    ])
      expect((await request).result.case).toBe("error");
  });

  it("continues to require a prepared human approval for a device or runtime operation", async () => {
    const result = await call("resources_create_or_update", "kubernetes", "remediation");
    expect(result.result.case).toBe("error");
    if (result.result.case === "error")
      expect(result.result.value.reason).toContain("approved change");
    expect(claim).toHaveBeenCalled();
  });
});
