import { randomUUID } from "node:crypto";
import { fromJson, type JsonObject } from "@bufbuild/protobuf";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { Role, SendMessageResponseSchema } from "../gen/a2a_pb.js";
import { knowledgeConfig } from "../server/knowledge/config.js";
import { knowledgeService } from "../server/knowledge/service.js";
import { sessionTools } from "../server/team-sessions/tools.js";
import { environment, testBindings } from "./harness.js";

it("discovers and dispatches the same concise input as native invocation through the MCP SDK", async () => {
  const { clients, fake, sync } = environment([]);
  const handler = sessionTools(
    clients,
    "agentos",
    testBindings(fake),
    knowledgeService(
      clients,
      knowledgeConfig({ namespace: "agentos", userId: "agentos", url: "http://localhost" }),
    ),
  );
  const client = new Client({ name: "collaboration-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
        fetch: (input, init) => handler.fetch(new Request(input, init)),
      }),
    );
    const { tools } = await client.listTools();
    const dispatch = tools.find((tool) => tool.name === "dispatch_session");
    expect(Object.keys(dispatch?.inputSchema.properties ?? {}).sort()).toEqual([
      "message",
      "message_id",
      "session_id",
    ]);
    expect(dispatch?.inputSchema.required?.slice().sort()).toEqual([
      "message",
      "message_id",
      "session_id",
    ]);
    const listed = await client.callTool({ name: "list_agents", arguments: {} });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.structuredContent)).toContain("inspection");
    const session = fake.createSession(
      { namespace: "agentos", name: "inspection" },
      randomUUID(),
      "Background check",
    );
    const messageId = randomUUID();
    const response = await client.callTool({
      name: "dispatch_session",
      arguments: { session_id: session.id, message_id: messageId, message: "  Inspect only.  " },
    });
    expect(response.isError).not.toBe(true);
    const accepted = fromJson(SendMessageResponseSchema, response.structuredContent as JsonObject);
    expect(accepted.payload.case).toBe("task");
    expect(fake.received.at(-1)).toMatchObject({
      contextId: session.id,
      messageId,
      role: Role.USER,
      parts: [{ content: { case: "text", value: "Inspect only." } }],
    });
    const received = fake.received.length;
    for (const args of [
      { session_id: session.id, message: "Missing identity" },
      { session_id: session.id, message_id: randomUUID(), message: " " },
      { session_id: session.id, message_id: randomUUID(), message: "Do work", taskId: "other" },
    ])
      expect(await client.callTool({ name: "dispatch_session", arguments: args })).toMatchObject({
        isError: true,
      });
    expect(fake.received).toHaveLength(received);
    expect(
      await client.callTool({ name: "list_agents", arguments: { namespace: "foreign" } }),
    ).toMatchObject({ isError: true });
  } finally {
    sync.close();
    await client.close();
    await handler.close();
  }
});
