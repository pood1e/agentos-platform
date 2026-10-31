import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { UserIdentitySchema } from "../gen/agentos/authorization/v1/identity_pb.js";
import { consoleClient, environment, operator } from "./harness.js";

afterEach(() => vi.restoreAllMocks());

it("starts the selected engineer directly with native identity and idempotency", async () => {
  const env = await environment([]);
  const identity = create(UserIdentitySchema, { subject: operator.subject });
  const client = consoleClient(env, {}, () => identity);
  const createSession = vi.spyOn(env.clients.sessions, "createSession");
  const request = {
    agent: { namespace: "agentos", name: "inspection" },
    messageId: "direct-engineer",
    text: "Inspect the selected fabric",
  };
  try {
    const result = await client.sendMessage(request);
    expect(await client.sendMessage(request)).toEqual(result);
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({ agent: request.agent });
    expect(env.fake.sessions.get(result.contextId)?.agent).toMatchObject(request.agent);
    expect(env.fake.received.every((message) => message.messageId === request.messageId)).toBe(
      true,
    );
    expect(env.fake.sessions.get(result.contextId)?.authority?.parentSessionId).toBeFalsy();
    await client.cancelTask({ taskId: result.taskId });
  } finally {
    await env.close();
  }
});

it("preserves workspace, privileged-role, native authorization and delegation gates", async () => {
  const env = await environment([]);
  const client = consoleClient(env, {}, () =>
    create(UserIdentitySchema, { subject: operator.subject }),
  );
  const request = { messageId: "direct-engineer-denied", text: "Inspect" };
  const createSession = vi.spyOn(env.clients.sessions, "createSession");
  try {
    for (const agent of [
      { namespace: "foreign", name: "inspection" },
      { namespace: "agentos", name: "role-builder" },
    ])
      await expect(client.sendMessage({ ...request, agent })).rejects.toMatchObject({
        code: Code.NotFound,
      });
    await expect(
      client.sendMessage({ ...request, agent: { namespace: "agentos", name: "" } }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(createSession).not.toHaveBeenCalled();
    const agent = { namespace: "agentos", name: "inspection" };
    createSession.mockRejectedValueOnce(new ConnectError("Native denied", Code.PermissionDenied));
    await expect(client.sendMessage({ ...request, agent })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    const credential = await env.clients.execution.getDelegationCredentialStatus({});
    vi.spyOn(env.clients.execution, "getDelegationCredentialStatus").mockResolvedValueOnce({
      ...credential,
      renewable: false,
    });
    await expect(client.sendMessage({ ...request, agent })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
      rawMessage: "delegation.required",
    });
    const resource = env.fake.agents.find((item) => item.ref?.name === "inspection")?.resource;
    if (!resource?.value) throw new Error("missing engineer");
    resource.value.status = { conditions: [{ type: "Ready", status: "False" }] };
    await expect(client.sendMessage({ ...request, agent })).rejects.toMatchObject({
      code: Code.Unavailable,
      rawMessage: "chat.notReady",
    });
    expect(env.fake.received).toHaveLength(0);
  } finally {
    await env.close();
  }
});
