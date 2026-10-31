import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { type Client, Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { UserIdentitySchema } from "../gen/agentos/authorization/v1/identity_pb.js";
import type {
  ConsoleService,
  WatchConversationRequest,
} from "../gen/agentos/console/v1/console_service_pb.js";
import { fixtureIds as ids } from "./fixtures/kagent.js";
import { consoleClient, type Environment, environment, operator } from "./harness.js";

afterEach(() => vi.restoreAllMocks());

function executionSession(env: Environment) {
  const root = env.fake.task(ids.dispatchRoot);
  const session = env.fake.sessions.get(root.contextId);
  assert(session?.agent);
  return { agent: session.agent, contextId: session.id };
}

async function snapshot(
  client: Client<typeof ConsoleService>,
  request: Pick<WatchConversationRequest, "agent" | "contextId">,
) {
  const controller = new AbortController();
  try {
    for await (const response of client.watchConversation(request, { signal: controller.signal }))
      return response.conversation;
    throw new Error("missing conversation");
  } finally {
    controller.abort();
  }
}

it.each([false, true])(
  "reads a caller-owned engineer session with administrator=%s",
  async (administrator) => {
    const env = await environment();
    const identity = create(UserIdentitySchema, {
      ...operator,
      capabilities: administrator ? operator.capabilities : [],
    });
    const client = consoleClient(env, {}, () => identity);
    const request = executionSession(env);
    try {
      const view = await snapshot(client, request);
      expect(view?.runs.map((run) => run.taskId)).toContain(ids.dispatchRoot);
      expect(view?.contextId).toBe(request.contextId);
      await expect(
        client.sendMessage({
          ...request,
          messageId: "direct-engineer-write",
          text: "Run another task",
        }),
      ).rejects.toMatchObject({ code: Code.NotFound });
    } finally {
      await env.close();
    }
  },
);

it("keeps other initiators' execution snapshots restricted to administrators", async () => {
  const env = await environment();
  const request = executionSession(env);
  const read = env.projection.session.bind(env.projection);
  vi.spyOn(env.projection, "session").mockImplementation(async (id) => {
    const result = await read(id);
    return result && { ...result, subject: "service:inspection" };
  });
  const ordinary = create(UserIdentitySchema, { subject: operator.subject });
  try {
    await expect(
      snapshot(
        consoleClient(env, {}, () => ordinary),
        request,
      ),
    ).rejects.toMatchObject({ code: Code.NotFound });
    expect((await snapshot(consoleClient(env), request))?.contextId).toBe(request.contextId);
  } finally {
    await env.close();
  }
});

it("retains native read failures and validates the session's workspace and agent", async () => {
  const env = await environment();
  const client = consoleClient(env);
  const request = executionSession(env);
  try {
    for (const target of [
      { ...request, agent: { ...request.agent, namespace: "foreign-workspace" } },
      { ...request, agent: { ...request.agent, name: "another-agent" } },
      { ...request, contextId: "" },
    ])
      await expect(snapshot(client, target)).rejects.toMatchObject({ code: Code.NotFound });
    for (const code of [Code.PermissionDenied, Code.Unavailable]) {
      vi.spyOn(env.projection, "session").mockRejectedValueOnce(
        new ConnectError("Native read rejected", code),
      );
      await expect(snapshot(client, request)).rejects.toMatchObject({ code });
    }
  } finally {
    await env.close();
  }
});
