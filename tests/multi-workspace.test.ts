import { create } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  createClient,
  createRouterTransport,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { UserIdentitySchema } from "../gen/agentos/authorization/v1/identity_pb.js";
import {
  ConsoleService,
  WatchConversationResponseSchema,
} from "../gen/agentos/console/v1/console_service_pb.js";
import {
  AuthorizationService,
  WorkspaceAuthorizationReferenceSchema,
} from "../gen/kagent/api/v1/authorization_pb.js";
import { authorizationService } from "../server/authorization/service.js";
import { kagentClients } from "../server/kagent/clients.js";
import { accessProfile, workspaceContext } from "../server/platform/access.js";
import { workspaceService } from "../server/platform/dispatch.js";
import { workspaceTargets } from "../server/platform/workspace-targets.js";
import { partialDirectoryHeader } from "../shared/kagent-resources.js";
import { workspaceFromPath, workspaceURL } from "../src/lib/workspace-route.js";

const principal = create(UserIdentitySchema, { subject: "oidc:alice" });

function setup(betaMember = false) {
  const received = new Map<string, ReturnType<typeof vi.fn>>();
  const authorities = new Map(
    ["alpha", "beta"].map((namespace) => {
      const list = vi.fn((request: { workspace?: { namespace: string; uid: string } }) => {
        if (namespace === "beta" && !betaMember) return { workspaces: [] };
        if (request.workspace?.namespace !== namespace) throw new Error("Wrong native authority");
        if (request.workspace.uid && request.workspace.uid !== `${namespace}-uid`)
          return { workspaces: [] };
        return { workspaces: [{ namespace, uid: `${namespace}-uid` }] };
      });
      received.set(namespace, list);
      const clients = kagentClients(
        createRouterTransport((router) =>
          router.service(AuthorizationService, { listWorkspaces: list }),
        ),
      );
      return [namespace, clients.authorization] as const;
    }),
  );
  const identity = async () => principal;
  const targets = new Map(
    ["alpha", "beta"].map(
      (namespace) =>
        [
          namespace,
          {
            entryAgent: "assistant",
            identity,
            member: async (_headers: Headers, _signal: AbortSignal, uid: string) => {
              if ((namespace === "beta" && !betaMember) || uid !== `${namespace}-uid`)
                throw new ConnectError("Workspace access denied", Code.PermissionDenied);
              return create(WorkspaceAuthorizationReferenceSchema, { namespace, uid });
            },
          },
        ] as const,
    ),
  );
  const services = new Map(
    ["alpha", "beta"].map(
      (namespace) =>
        [
          namespace,
          {
            getAccessProfile: (_request: unknown, context: HandlerContext) => ({
              profile: context.values.get(accessProfile),
            }),
            async *watchConversation() {
              yield create(WatchConversationResponseSchema, {
                conversation: { contextId: namespace },
              });
            },
          } as unknown as ServiceImpl<typeof ConsoleService>,
        ] as const,
    ),
  );
  const transport = createRouterTransport(
    (router) => {
      router.service(ConsoleService, workspaceService(ConsoleService, services));
      router.service(
        AuthorizationService,
        authorizationService(authorities, "alpha", { warn: vi.fn() }),
      );
    },
    { router: { interceptors: [workspaceContext(identity, targets)] } },
  );
  return {
    console: createClient(ConsoleService, transport),
    authorization: createClient(AuthorizationService, transport),
    received,
  };
}

it("lists only memberships from configured native authorities", async () => {
  const env = setup();
  const result = await env.authorization.listWorkspaces(
    {},
    { headers: { authorization: "Bearer alice" } },
  );
  expect(result.workspaces).toMatchObject([{ namespace: "alpha", uid: "alpha-uid" }]);
  expect(env.received.get("alpha")).toHaveBeenCalledWith(
    expect.objectContaining({ workspace: expect.objectContaining({ namespace: "alpha" }) }),
    expect.anything(),
  );
  expect(env.received.get("beta")).toHaveBeenCalledOnce();
  await expect(
    env.authorization.listWorkspaces({ workspace: { namespace: "unconfigured" } }),
  ).rejects.toMatchObject({ code: Code.NotFound });
});

it("paginates memberships from separate native authorities", async () => {
  const env = setup(true);
  const first = await env.authorization.listWorkspaces({ page: { limit: 1 } });
  expect(first.workspaces).toMatchObject([{ namespace: "alpha", uid: "alpha-uid" }]);
  expect(first.page?.nextPageToken).toBeTruthy();
  const second = await env.authorization.listWorkspaces({
    page: { limit: 1, pageToken: first.page?.nextPageToken },
  });
  expect(second.workspaces).toMatchObject([{ namespace: "beta", uid: "beta-uid" }]);
  expect(second.page?.nextPageToken).toBe("");
});

function directory(answers: Record<string, () => unknown>) {
  const warn = vi.fn();
  const authorities = new Map(
    Object.entries(answers).map(
      ([namespace, answer]) =>
        [
          namespace,
          kagentClients(
            createRouterTransport((router) =>
              router.service(AuthorizationService, { listWorkspaces: () => answer() as never }),
            ),
          ).authorization,
        ] as const,
    ),
  );
  const [home = ""] = Object.keys(answers);
  return {
    warn,
    client: createClient(
      AuthorizationService,
      createRouterTransport((router) =>
        router.service(AuthorizationService, authorizationService(authorities, home, { warn })),
      ),
    ),
  };
}
const member = (namespace: string) => () => ({
  workspaces: [{ namespace, uid: `${namespace}-uid` }],
});
const failing = (code: Code) => () => {
  throw new ConnectError("authority failed", code);
};
const partialHeader = (client: ReturnType<typeof directory>["client"]) =>
  new Promise<boolean>((resolve, reject) => {
    client
      .listWorkspaces({}, { onHeader: (headers) => resolve(headers.has(partialDirectoryHeader)) })
      .catch(reject);
  });

it("keeps reachable workspaces and reports the outage of another native authority", async () => {
  const { client, warn } = directory({
    alpha: member("alpha"),
    beta: failing(Code.Unavailable),
    gamma: member("gamma"),
  });
  const result = await client.listWorkspaces({});
  expect(result.workspaces.map((item) => item.namespace)).toEqual(["alpha", "gamma"]);
  expect(await partialHeader(client)).toBe(true);
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ namespace: "beta" }),
    expect.any(String),
  );
});

it("does not report a denied authority as an outage", async () => {
  const { client, warn } = directory({
    alpha: member("alpha"),
    beta: failing(Code.PermissionDenied),
  });
  const result = await client.listWorkspaces({});
  expect(result.workspaces.map((item) => item.namespace)).toEqual(["alpha"]);
  expect(await partialHeader(client)).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

it("fails the directory only when no native authority can answer", async () => {
  const { client } = directory({
    alpha: failing(Code.Unauthenticated),
    beta: failing(Code.Unauthenticated),
  });
  await expect(client.listWorkspaces({})).rejects.toMatchObject({ code: Code.Unauthenticated });
  const unreachable = directory({
    alpha: failing(Code.Unavailable),
    beta: failing(Code.PermissionDenied),
  });
  const empty = await unreachable.client.listWorkspaces({});
  expect(empty.workspaces).toEqual([]);
  expect(await partialHeader(unreachable.client)).toBe(true);
});

it("binds every console request to the selected namespace and current UID", async () => {
  const env = setup();
  const options = {
    headers: { "x-agentos-workspace": "alpha", "x-agentos-workspace-uid": "alpha-uid" },
  };
  expect((await env.console.getAccessProfile({}, options)).profile?.workspace).toMatchObject({
    namespace: "alpha",
    uid: "alpha-uid",
  });
  await expect(env.console.getAccessProfile({})).rejects.toMatchObject({
    code: Code.InvalidArgument,
  });
  await expect(
    env.console.getAccessProfile(
      {},
      { headers: { ...options.headers, "x-agentos-workspace-uid": "old-uid" } },
    ),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
  await expect(
    env.console.getAccessProfile(
      {},
      { headers: { ...options.headers, "x-agentos-workspace": "beta" } },
    ),
  ).rejects.toMatchObject({ code: Code.PermissionDenied });
});

it("dispatches streaming handlers without crossing workspace bundles", async () => {
  const env = setup(true);
  for (const namespace of ["alpha", "beta"]) {
    const stream = env.console.watchConversation(
      {},
      {
        headers: {
          "x-agentos-workspace": namespace,
          "x-agentos-workspace-uid": `${namespace}-uid`,
        },
      },
    );
    for await (const item of stream) {
      expect(item.conversation?.contextId).toBe(namespace);
      break;
    }
  }
});

it("uses namespace and UID in browser routes", () => {
  const workspace = create(WorkspaceAuthorizationReferenceSchema, {
    namespace: "alpha",
    uid: "alpha-uid",
  });
  expect(workspaceURL(workspace)).toBe("/w/alpha/alpha-uid/chat");
  expect(workspaceFromPath("/w/alpha/alpha-uid/chat")).toMatchObject(workspace);
  expect(workspaceFromPath("/w/alpha/%2e%2e/chat")).toBeUndefined();
});

it("rejects malformed or duplicate target configuration", () => {
  const target = {
    namespace: "alpha",
    release: "agentos",
    entryAgent: "assistant",
    harness: "standard",
    kagentURL: "http://kagent:8083",
  };
  expect(workspaceTargets({ AGENTOS_WORKSPACES: JSON.stringify([target]) })).toHaveLength(1);
  expect(() => workspaceTargets({ AGENTOS_WORKSPACES: JSON.stringify([target, target]) })).toThrow(
    "Duplicate",
  );
  expect(() =>
    workspaceTargets({
      AGENTOS_WORKSPACES: JSON.stringify([{ ...target, kagentURL: "file:///tmp/x" }]),
    }),
  ).toThrow("Invalid");
});
