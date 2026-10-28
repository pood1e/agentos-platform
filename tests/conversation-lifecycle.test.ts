import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { expect, it, vi } from "vitest";
import { DeleteSessionRequestSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { conversationCommands } from "../server/console/conversations.js";
import { environment, operator } from "./harness.js";

it("delegates deletion admission and history removal to the native API", async () => {
  const env = await environment([]);
  const session = env.fake.createSession(
    { namespace: "agentos", name: "assistant" },
    "delete-request",
    "Delete target",
  );
  const remove = conversationCommands(env.clients, "agentos", "assistant").remove;
  const deleted = vi.spyOn(env.clients.sessions, "deleteSession");
  await remove(create(DeleteSessionRequestSchema, { sessionId: session.id }), operator);
  expect(deleted).toHaveBeenCalledExactlyOnceWith(
    create(DeleteSessionRequestSchema, { sessionId: session.id }),
    { timeoutMs: 30_000 },
  );
  expect(env.fake.sessions.has(session.id)).toBe(false);
});

it.each([Code.Aborted, Code.FailedPrecondition])(
  "maps native concurrent execution conflict %i to the console's busy state",
  async (code) => {
    const env = await environment([]);
    const session = env.fake.createSession(
      { namespace: "agentos", name: "assistant" },
      "busy-request",
      "Busy target",
    );
    vi.spyOn(env.clients.sessions, "deleteSession").mockRejectedValue(
      new ConnectError("native execution active", code),
    );
    await expect(
      conversationCommands(env.clients, "agentos", "assistant").remove(
        create(DeleteSessionRequestSchema, { sessionId: session.id }),
        operator,
      ),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition, rawMessage: "chat.deleteBusy" });
    expect(env.fake.sessions.has(session.id)).toBe(true);
  },
);

it("preserves native ownership denial before issuing a delete", async () => {
  const env = await environment([]);
  vi.spyOn(env.clients.sessions, "getSession").mockRejectedValue(
    new ConnectError("foreign session", Code.NotFound),
  );
  const deleted = vi.spyOn(env.clients.sessions, "deleteSession");
  await expect(
    conversationCommands(env.clients, "agentos", "assistant").remove(
      create(DeleteSessionRequestSchema, { sessionId: "foreign" }),
      operator,
    ),
  ).rejects.toMatchObject({ code: Code.NotFound });
  expect(deleted).not.toHaveBeenCalled();
});
