import { create } from "@bufbuild/protobuf";
import { Code, createClient, createRouterTransport } from "@connectrpc/connect";
import { expect, it } from "vitest";
import { UserIdentitySchema } from "../gen/agentos/authorization/v1/identity_pb.js";
import { Capability } from "../gen/agentos/authorization/v1/permission_pb.js";
import { MemoryService } from "../gen/kagent/runtime/v1/memory_pb.js";
import { agentMemory } from "../server/console/memory.js";
import { kagentClients } from "../server/kagent/clients.js";
import { nativeCredentials } from "../server/kagent/context.js";
import { workspaceService } from "../server/platform/dispatch.js";
import { allowWorkspace, testWorkspaceContext } from "./workspace-member.js";

function setup() {
  const calls: { method: string; agent: string; authorization: string | null }[] = [];
  const native = kagentClients(
    createRouterTransport(
      (router) =>
        router.service(MemoryService, {
          list(request, context) {
            calls.push({
              method: "list",
              agent: request.agentName,
              authorization: context.requestHeader.get("authorization"),
            });
            return { memories: [{ id: "finding", content: "Restart the ingress after rotation" }] };
          },
          deleteEntry(request, context) {
            calls.push({
              method: "deleteEntry",
              agent: request.agentName,
              authorization: context.requestHeader.get("authorization"),
            });
            return {};
          },
        }),
      { transport: { interceptors: [nativeCredentials] } },
    ),
  );
  const identity = async (headers: Headers) =>
    create(UserIdentitySchema, {
      subject: "user:operator",
      capabilities:
        headers.get("authorization") === "Bearer manager" ? [Capability.AGENTS_MANAGE] : [],
    });
  const client = createClient(
    MemoryService,
    createRouterTransport(
      (router) =>
        router.service(
          MemoryService,
          workspaceService(
            MemoryService,
            new Map([["workspace", agentMemory(native.memory, "workspace")]]),
          ),
        ),
      {
        router: {
          interceptors: [testWorkspaceContext("workspace", identity, allowWorkspace("workspace"))],
        },
      },
    ),
  );
  return { client, calls };
}

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

it("lists an Agent's shared memory with the caller's native credentials", async () => {
  const { client, calls } = setup();
  const { memories } = await client.list({ agentName: "workspace/knowledge" }, as("reader"));
  expect(memories.map((memory) => memory.content)).toEqual(["Restart the ingress after rotation"]);
  expect(calls).toEqual([
    { method: "list", agent: "workspace/knowledge", authorization: "Bearer reader" },
  ]);
});

it("keeps other workspaces' Agents out of the workspace route", async () => {
  const { client, calls } = setup();
  await expect(client.list({ agentName: "other/knowledge" }, as("reader"))).rejects.toMatchObject({
    code: Code.NotFound,
  });
  expect(calls).toEqual([]);
});

it("lets only Agent managers curate memory", async () => {
  const { client, calls } = setup();
  const entry = { agentName: "workspace/knowledge", id: "finding" };
  await expect(client.deleteEntry(entry, as("reader"))).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
  await client.deleteEntry(entry, as("manager"));
  expect(calls).toEqual([
    { method: "deleteEntry", agent: "workspace/knowledge", authorization: "Bearer manager" },
  ]);
});

it("denies native memory writes and searches through the API", async () => {
  const { client } = setup();
  await expect(
    client.delete({ agentName: "workspace/knowledge" }, as("manager")),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  await expect(
    client.search({ managementAgent: "workspace/knowledge" }, as("manager")),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
});
