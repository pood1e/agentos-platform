import { create, type JsonObject } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionKind, ManagementService } from "../gen/agentos/management/v1/management_pb.js";
import { ToolServerSchema } from "../gen/kagent/api/v1/tools_pb.js";
import { object, text } from "../server/read-model/decode/messages.js";
import { managementEnvironment } from "./management-harness.js";

let env: Awaited<ReturnType<typeof managementEnvironment>>;
let client: ReturnType<typeof createClient<typeof ManagementService>>;
const service = "lab-grafana";
const profile = `${service}-inspection`;

beforeEach(async () => {
  env = await managementEnvironment();
  client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service)),
  );
  for (const name of [service, profile]) {
    const value: JsonObject = {
      apiVersion: "agentgateway.dev/v1alpha1",
      kind: "AgentgatewayBackend",
      metadata: {
        name,
        labels:
          name === profile
            ? { "agentos.dev/engineer": "inspection" }
            : { "agentos.dev/project": "grafana" },
        annotations: { "agentos.dev/system-connection": "false" },
      },
      spec: {
        mcp: {
          prefixMode: "Always",
          targets: [
            {
              name: service,
              static: {
                host: "gateway.example",
                port: 8080,
                path: "/mcp/grafana",
                policies: { auth: { secretRef: { name: `${name}-credential` } } },
              },
            },
          ],
        },
      },
    };
    env.fake.resources.save("agentgatewaybackends", value, true);
    env.fake.toolServers.push(
      create(ToolServerSchema, {
        ref: `agentos/${name}`,
        discoveredTools: [{ name: `${service}_query_loki_logs`, description: "Query logs" }],
      }),
    );
  }
  const template = env.fake.templates.get("inspection")?.resource?.value;
  if (template)
    object(template.spec).tools = [
      {
        mcp: {
          server: { name: profile, kind: "RemoteMCPServer" },
          tools: [`${service}_query_loki_logs`],
        },
      },
    ];
});
afterEach(async () => env.close());

describe("MCP services and credential bindings", () => {
  it("refuses API edits to compiled environment resources", async () => {
    const before = await env.store.get("mcps", profile);
    const { connections } = await client.listConnections({ kind: ConnectionKind.MCP });
    const connection = connections.find(
      (item) => object(item.resource?.value?.metadata).name === service,
    );
    await expect(client.saveConnection({ connection })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(await env.store.get("mcps", profile)).toEqual(before);
  });

  it("lists built-in services with discovered tools while protecting their configuration", async () => {
    const { connections } = await client.listConnections({ kind: ConnectionKind.MCP });
    const builtins = connections.filter(
      (item) =>
        item.systemManaged &&
        !object(item.resource?.value?.metadata).name?.toString().startsWith("lab-"),
    );
    expect(builtins.map((item) => object(item.resource?.value?.metadata).name)).toEqual([
      "kagent-collaboration",
      "team-sessions",
    ]);
    for (const connection of builtins) {
      expect(connection.tools.length).toBeGreaterThan(0);
      await expect(client.saveConnection({ connection })).rejects.toMatchObject({
        code: Code.FailedPrecondition,
      });
      await expect(
        client.deleteConnection({
          kind: ConnectionKind.MCP,
          name: text(object(connection.resource?.value?.metadata).name),
          resourceVersion: text(object(connection.resource?.value?.metadata).resourceVersion),
        }),
      ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    }
  });

  it("keeps an unavailable service in use while its engineer binding exists", async () => {
    env.fake.toolServers.splice(0, env.fake.toolServers.length);
    const { connections } = await client.listConnections({ kind: ConnectionKind.MCP });
    const connection = connections.find(
      (item) => object(item.resource?.value?.metadata).name === service,
    );
    expect(connection?.usedBy).toEqual(["inspection"]);
    await expect(
      client.deleteConnection({
        kind: ConnectionKind.MCP,
        name: service,
        resourceVersion: text(object(connection?.resource?.value?.metadata).resourceVersion),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });
  it("lists one managed service and scopes its identity tools and consumers", async () => {
    const { connections } = await client.listConnections({ kind: ConnectionKind.MCP });
    const connection = connections.find(
      (item) => object(item.resource?.value?.metadata).name === service,
    );
    expect(
      connections.some((item) => object(item.resource?.value?.metadata).name === profile),
    ).toBe(false);
    expect(connection?.systemManaged).toBe(true);
    expect(connection?.tools).toHaveLength(1);
    expect(connection?.usedBy).toEqual(["inspection"]);
    expect(connection?.credentialBindings.map((binding) => binding.engineer)).toEqual([
      "catalog",
      "assistant",
      "coordinator",
      "diagnosis",
      "inspection",
      "remediation",
    ]);
    const current = await env.store.get("mcps", profile);
    await expect(
      client.deleteConnection({
        kind: ConnectionKind.MCP,
        name: profile,
        resourceVersion: text(object(current.metadata).resourceVersion),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(
      client.deleteConnection({
        kind: ConnectionKind.MCP,
        name: service,
        resourceVersion: text(object(connection?.resource?.value?.metadata).resourceVersion),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
  });

  it("ignores forged identity labels and reads profiles from compiled status", async () => {
    const backend = await env.store.get("mcps", profile);
    object(object(backend.metadata).labels)["agentos.dev/engineer"] = "borrowed";
    await env.store.save("mcps", backend, false);
    const { connections } = await client.listConnections({ kind: ConnectionKind.MCP });
    const connection = connections.find(
      (item) => object(item.resource?.value?.metadata).name === service,
    );
    expect(connection?.credentialBindings.some((binding) => binding.engineer === "borrowed")).toBe(
      false,
    );
    expect(
      connection?.credentialBindings.some((binding) => binding.engineer === "inspection"),
    ).toBe(true);
  });
});
