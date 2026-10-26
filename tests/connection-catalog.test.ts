import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import {
  ConnectionKind,
  ConnectionSchema,
  ManagementService,
} from "../gen/agentos/management/v1/management_pb.js";
import { meta } from "../server/management/native.js";
import { managementEnvironment } from "./management-harness.js";

it("excludes inbound endpoints before pagination and protects them without hiding undiscovered services", async () => {
  const env = await managementEnvironment();
  const client = createClient(
    ManagementService,
    createRouterTransport((router) => router.service(ManagementService, env.service)),
  );
  try {
    const ingress = await env.store.save(
      "mcps",
      {
        apiVersion: "agentgateway.dev/v1alpha1",
        kind: "AgentgatewayBackend",
        metadata: {
          name: "catalog-a-ingress",
          annotations: {
            "agentos.dev/connection-role": "ingress",
            "agentos.dev/system-connection": "true",
          },
        },
        spec: { mcp: { targets: [{ name: "ingress", static: { host: "console", port: 8080 } }] } },
      },
      true,
    );
    for (const name of ["catalog-b-empty", "catalog-c-empty"])
      await env.store.save("mcps", { ...ingress, metadata: { name }, spec: ingress.spec }, true);
    const request = { kind: ConnectionKind.MCP, query: "catalog-", pageSize: 1 };
    const first = await client.listConnections(request);
    expect(first.totalSize).toBe(2);
    expect(first.connections.map((item) => meta(item.resource?.value ?? {}).name)).toEqual([
      "catalog-b-empty",
    ]);
    expect(first.connections[0]?.tools).toEqual([]);
    const next = await client.listConnections({ ...request, pageToken: first.nextPageToken });
    expect(next.connections.map((item) => meta(item.resource?.value ?? {}).name)).toEqual([
      "catalog-c-empty",
    ]);
    await expect(
      client.saveConnection({
        connection: create(ConnectionSchema, {
          kind: ConnectionKind.MCP,
          resource: { value: ingress },
        }),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    await expect(
      client.deleteConnection({
        kind: ConnectionKind.MCP,
        name: "catalog-a-ingress",
        resourceVersion: String(meta(ingress).resourceVersion),
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(await env.store.get("mcps", "catalog-a-ingress")).toEqual(ingress);
  } finally {
    await env.close();
  }
});
