import { create } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { UserIdentitySchema } from "../gen/agentos/authorization/v1/identity_pb.js";
import {
  AccessRole,
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
  AuthorizationService,
  type GrantRoleRequest,
  GrantRoleRequestSchema,
  type ListRoleBindingsRequest,
  type ListWorkspacesRequest,
} from "../gen/kagent/api/v1/authorization_pb.js";
import { authorizationService } from "../server/authorization/service.js";
import { registerConsole } from "../server/console/app.js";
import { consoleService } from "../server/console/service.js";
import { kagentClients } from "../server/kagent/clients.js";
import { allCapabilities } from "../shared/permissions.js";
import { consoleDependencies, environment } from "./harness.js";
import { allowWorkspace, testWorkspaceContext } from "./workspace-member.js";

function setup(implementation: Partial<ServiceImpl<typeof AuthorizationService>>) {
  const native = kagentClients(
    createRouterTransport((router) => router.service(AuthorizationService, implementation)),
  );
  const principal = create(UserIdentitySchema, { subject: "oidc:alice" });
  const service = authorizationService(new Map([["team", native.authorization]]), "team", {
    warn: vi.fn(),
  });
  const context = testWorkspaceContext("team", async () => principal, allowWorkspace("team"));
  const client = createClient(
    AuthorizationService,
    createRouterTransport((router) => router.service(AuthorizationService, service), {
      router: { interceptors: [context] },
    }),
  );
  return { principal, service, context, client };
}

const grantRequest = () =>
  create(GrantRoleRequestSchema, {
    requestId: crypto.randomUUID(),
    workspace: { namespace: "team", uid: "team-uid" },
    binding: {
      role: AccessRole.WORKSPACE_MEMBER,
      scope: { resource: { case: "workspace", value: { namespace: "team" } } },
      subject: { subject: { case: "principalId", value: "oidc:bob" } },
    },
  });

it("delegates access decisions to native authorization with actual credentials", async () => {
  const received: Headers[] = [];
  const grant = vi.fn((_request: GrantRoleRequest, context: HandlerContext) => {
    received.push(new Headers(context.requestHeader));
    return {};
  });
  const { client, principal } = setup({ grantRole: grant });
  const headers = {
    authorization: "Bearer current",
    "x-user-id": "forged-admin",
    "x-auth-request-groups": "admins",
    "x-forwarded-access-token": "forged",
  };
  await client.grantRole(grantRequest(), { headers });
  expect(principal.capabilities).toEqual([]);
  expect(grant).toHaveBeenCalledOnce();
  expect(received[0]?.get("authorization")).toBe("Bearer current");
  for (const name of ["x-user-id", "x-auth-request-groups", "x-forwarded-access-token"])
    expect(received[0]?.has(name)).toBe(false);
  principal.capabilities = allCapabilities;
  grant.mockImplementationOnce(() => {
    throw new ConnectError("Native role denied", Code.PermissionDenied);
  });
  await expect(client.grantRole(grantRequest(), { headers })).rejects.toMatchObject({
    code: Code.PermissionDenied,
  });
});

it("forwards workspace scope to native authorization", async () => {
  const read = vi.fn((_request: ListRoleBindingsRequest) => ({ bindings: [] }));
  const list = vi.fn((_request: ListWorkspacesRequest) => ({
    workspaces: [{ namespace: "team", uid: "workspace-2" }],
  }));
  const { client } = setup({
    listWorkspaces: list,
    listRoleBindings: read,
  });
  const directory = await client.listWorkspaces({
    workspace: { namespace: "team", uid: "workspace-2" },
  });
  expect(directory.workspaces).toMatchObject([{ namespace: "team", uid: "workspace-2" }]);
  expect(list).toHaveBeenCalledOnce();
  expect(list.mock.calls[0]?.[0].workspace).toMatchObject({
    namespace: "team",
    uid: "workspace-2",
  });
  await client.listRoleBindings({
    workspace: { namespace: "team", uid: "workspace-2" },
    scope: { resource: { case: "workspace", value: { namespace: "team", uid: "workspace-2" } } },
  });
  expect(read.mock.calls[0]?.[0].workspace).toMatchObject({
    namespace: "team",
    uid: "workspace-2",
  });
});

it("propagates cancellation through the native authorization call", async () => {
  let started: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let canceled: () => void = () => {};
  const cancellation = new Promise<void>((resolve) => {
    canceled = resolve;
  });
  const { client } = setup({
    checkPermissions: (_request, context) =>
      new Promise((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            canceled();
            resolve({});
          },
          { once: true },
        );
        started();
      }),
  });
  const controller = new AbortController();
  const request = client.checkPermissions(
    { workspace: { namespace: "team", uid: "team-uid" } },
    { signal: controller.signal },
  );
  await pending;
  controller.abort();
  await expect(request).rejects.toMatchObject({ code: Code.Canceled });
  await cancellation;
});

it("registers the native contract on HTTP and validates requests before upstream mutations", async () => {
  const env = await environment();
  const upstream = vi.fn(() => ({}));
  const proxy = setup({
    listAccessRoles: () => ({ roles: [{ role: AccessRole.WORKSPACE_MEMBER }] }),
    listWorkspaces: () => ({ workspaces: [{ namespace: "team", uid: "workspace-1" }] }),
    grantRole: upstream,
  });
  const app = Fastify();
  await registerConsole(app, {
    context: proxy.context,
    authorization: proxy.service,
    service: consoleService(consoleDependencies(env, { namespace: "team" })),
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = createClient(
    AuthorizationService,
    createConnectTransport({ baseUrl: url, httpVersion: "1.1" }),
  );
  try {
    const result = await client.listAccessRoles({});
    expect(result.roles[0]?.role).toBe(AccessRole.WORKSPACE_MEMBER);
    const workspaces = await client.listWorkspaces({});
    expect(workspaces.workspaces[0]?.uid).toBe("workspace-1");
    await expect(client.listWorkspaces({ page: { limit: 101 } })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    await expect(
      client.listWorkspaces({
        workspace: { namespace: "team" },
        page: { pageToken: "cursor" },
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    await expect(client.grantRole({})).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(upstream).not.toHaveBeenCalled();
    await client.grantRole(grantRequest());
    expect(upstream).toHaveBeenCalledOnce();
    const toolGrant = grantRequest();
    if (!toolGrant.binding) throw new Error("Missing test binding");
    toolGrant.binding.role = AccessRole.DEPENDENCY_USER;
    toolGrant.binding.scope = create(AuthorizationResourceSchema, {
      resource: {
        case: "mcpTool",
        value: {
          server: {
            kind: AuthorizationScopeKind.MCP_SERVER,
            ref: { namespace: "team", name: "tools.v2" },
            uid: "server-uid",
          },
          name: "Read/Logs & metrics ",
        },
      },
    });
    await client.grantRole(toolGrant);
    expect(upstream).toHaveBeenLastCalledWith(
      expect.objectContaining({ binding: toolGrant.binding }),
      expect.anything(),
    );
    const tool = toolGrant.binding.scope.resource;
    if (tool.case !== "mcpTool" || !tool.value.server) throw new Error("Missing test tool");
    tool.value.server.kind = AuthorizationScopeKind.HARNESS;
    await expect(client.grantRole(toolGrant)).rejects.toMatchObject({ code: Code.InvalidArgument });
    tool.value.server.kind = AuthorizationScopeKind.MCP_SERVER;
    tool.value.name = "x".repeat(129);
    await expect(client.grantRole(toolGrant)).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(upstream).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
    await env.close();
  }
});
