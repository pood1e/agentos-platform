import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { ExecutionIdentitySchema } from "../gen/agentos/execution/v1/identity_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { scopedCollaboration } from "../server/authorization/context.js";
import type { Executions } from "../server/authorization/executions.js";
import { knowledgeConfig } from "../server/knowledge/config.js";
import { knowledgeService } from "../server/knowledge/service.js";
import { sessionTools } from "../server/team-sessions/tools.js";
import { environment, testBindings } from "./harness.js";

it("keeps two concurrent callers separate through the same MCP handler and tool factory", async () => {
  const { fake, clients, sync } = environment([]);
  const requestId = "scheduled-run/11111111-1111-4111-8111-111111111111";
  const reserved = fake.createSession(
    { namespace: "agentos", name: "inspection" },
    requestId,
    "System task",
  );
  const existing = fake.sessions.size;
  const bound: { subject: string; parent: string; name: string }[] = [];
  const registry = {
    resolve: async (parent: { id: string }) => {
      await new Promise((resolve) => setTimeout(resolve, parent.id === "alice" ? 30 : 1));
      return {
        identity: create(ExecutionIdentitySchema, {
          subject: parent.id,
          write: parent.id === "alice",
        }),
      };
    },
    bind: async (
      session: { name: string },
      identity: { subject: string },
      parent: { id: string },
    ) => {
      bound.push({ subject: identity.subject, parent: parent.id, name: session.name });
    },
  } as unknown as Executions;
  const shared = sessionTools(
    clients,
    "agentos",
    testBindings(fake),
    knowledgeService(
      clients,
      knowledgeConfig({ namespace: "agentos", userId: "agentos", url: "http://localhost" }),
    ),
  );
  try {
    await Promise.all(
      ["alice", "bob"].map(async (subject) => {
        const handler = scopedCollaboration(
          shared,
          create(SessionSchema, { id: subject }),
          registry,
        );
        const response = await handler.fetch(
          new Request("http://127.0.0.1/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: subject,
              method: "tools/call",
              params: {
                name: "create_session",
                arguments: {
                  agent: { namespace: "agentos", name: "inspection" },
                  name: subject,
                  requestId,
                },
              },
            }),
          }),
        );
        const body = await response.text();
        expect(body).not.toContain('"isError":true');
      }),
    );
    expect(bound.sort((a, b) => a.subject.localeCompare(b.subject))).toEqual([
      { subject: "alice", parent: "alice", name: "alice" },
      { subject: "bob", parent: "bob", name: "bob" },
    ]);
    expect(fake.sessions.size).toBe(existing + 2);
    expect(fake.sessions.get(reserved.id)?.name).toBe("System task");
  } finally {
    sync.close();
    await shared.close();
  }
});
