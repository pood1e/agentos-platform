import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { GetConfigurationResponseSchema } from "../gen/agentos/console/v1/console_service_pb.js";
import { AuthorizationScopeKind } from "../gen/kagent/api/v1/authorization_pb.js";
import { dependencyOptions } from "../src/features/authorization/dependency-options.js";
import {
  resourceFromSearch,
  resourceSearch,
} from "../src/features/authorization/resource-location.js";

const configuration = create(GetConfigurationResponseSchema, {
  harnesses: [
    { ref: { namespace: "team", name: "standard" } },
    { ref: { namespace: "other", name: "private" } },
  ],
  modelConfigs: [
    { ref: { namespace: "team", name: "model.v2" } },
    { ref: { namespace: "other", name: "private" } },
  ],
  toolServers: [
    {
      ref: "team/inspection",
      groupKind: "RemoteMCPServer.api.kagent.dev",
      discoveredTools: [{ name: "Read/Logs" }, { name: "read/logs" }],
    },
    {
      ref: "team/remediation",
      groupKind: "RemoteMCPServer.api.kagent.dev",
      discoveredTools: [{ name: "Read/Logs" }],
    },
    { ref: "other/private", groupKind: "RemoteMCPServer.api.kagent.dev" },
    { ref: "team/legacy", groupKind: "Service" },
    { ref: "team/invalid/path", groupKind: "RemoteMCPServer.api.kagent.dev" },
  ],
});

it.each([
  [AuthorizationScopeKind.HARNESS, ["standard"]],
  [AuthorizationScopeKind.MODEL_CONNECTION, ["model.v2"]],
  [AuthorizationScopeKind.MCP_SERVER, ["inspection", "remediation"]],
] as const)("lists workspace-native dependencies for scope %s", (kind, names) => {
  const options = dependencyOptions("team", kind, configuration);
  expect(options.map((item) => item.label)).toEqual(names);
  for (const item of options)
    expect(resourceFromSearch("team", resourceSearch(item.resource))).toEqual(item.resource);
});

it("keeps MCP servers and exact case-sensitive tool names as separate scopes", () => {
  const options = dependencyOptions("team", AuthorizationScopeKind.MCP_TOOL, configuration);
  expect(options.map((item) => item.label)).toEqual([
    "inspection / Read/Logs",
    "inspection / read/logs",
    "remediation / Read/Logs",
  ]);
  expect(new Set(options.map((item) => resourceSearch(item.resource).toString())).size).toBe(3);
  for (const item of options)
    expect(resourceFromSearch("team", resourceSearch(item.resource))).toEqual(item.resource);
});
