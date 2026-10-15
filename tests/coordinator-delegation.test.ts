import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import {
  GetAgentResponseSchema,
  ListAgentsResponseSchema,
} from "../gen/kagent/api/v1alpha1/agents_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1alpha1/sessions_pb.js";
import { coordinatorDelegation } from "../server/team-sessions/delegate.js";
import { environment } from "./harness.js";

const message = (contextId = "") => ({
  messageId: "handoff-request",
  contextId,
  role: "ROLE_USER",
  parts: [{ text: "用中文核验给定目标，只读。" }],
});

describe("chat delegation", () => {
  it("creates only coordinator sessions and reuses native creation identity on retries", async () => {
    const { clients } = environment();
    const createSession = vi.spyOn(clients.sessions, "createSession");
    const invoke = vi.fn(async () => ({
      content: [],
      structuredContent: { state: "TASK_STATE_COMPLETED" },
    }));
    const delegate = coordinatorDelegation(clients, "agentos", invoke);
    expect(await delegate(message())).toHaveProperty(
      "structuredContent.state",
      "TASK_STATE_COMPLETED",
    );
    await delegate(message());
    for (const [request] of createSession.mock.calls)
      expect(request).toEqual({
        agent: { namespace: "agentos", name: "coordinator" },
        requestId: "handoff-request",
      });
    expect(invoke.mock.calls).toHaveLength(2);
  });

  it("reuses a coordinator session and preserves pending user input", async () => {
    const { clients, fake } = environment();
    const session = [...fake.sessions.values()].find((item) => item.agent?.name === "coordinator");
    expect(session).toBeDefined();
    const createSession = vi.spyOn(clients.sessions, "createSession");
    const invoke = vi.fn(
      async (_session: string, _id: string, _message: string, _signal?: AbortSignal) => ({
        content: [],
        structuredContent: { session_id: session?.id, state: "TASK_STATE_INPUT_REQUIRED" },
      }),
    );
    const delegate = coordinatorDelegation(clients, "agentos", invoke);
    expect(await delegate(message(session?.id))).toHaveProperty(
      "structuredContent.state",
      "TASK_STATE_INPUT_REQUIRED",
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      session?.id,
      "handoff-request",
      "用中文核验给定目标，只读。",
      undefined,
    );
  });

  it("rejects other engineers and foreign workspaces before invoking them", async () => {
    const { clients, fake } = environment();
    const invoke = vi.fn(async () => ({ content: [] }));
    const delegate = coordinatorDelegation(clients, "agentos", invoke);
    for (const session of [...fake.sessions.values()].filter(
      (item) => item.agent?.name !== "coordinator",
    ))
      await expect(delegate(message(session.id))).rejects.toThrow();
    const foreign = create(SessionSchema, {
      id: "4de081ea-88c3-4d52-b7bb-aaee35e03a5d",
      agent: { namespace: "another-team", name: "coordinator" },
    });
    fake.sessions.set(foreign.id, foreign);
    await expect(delegate(message(foreign.id))).rejects.toThrow(/workspace/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects forged destinations and malformed delegation messages", async () => {
    const { clients } = environment();
    const invoke = vi.fn(async () => ({ content: [] }));
    const createSession = vi.spyOn(clients.sessions, "createSession");
    const delegate = coordinatorDelegation(clients, "agentos", invoke);
    for (const invalid of [
      { ...message(), agent: { namespace: "agentos", name: "remediation" } },
      { ...message(), role: "ROLE_AGENT" },
      { ...message(), messageId: "" },
      { ...message(), parts: [{ text: " " }] },
      { ...message(), taskId: "another-task" },
    ])
      await expect(delegate(invalid)).rejects.toThrow();
    expect(createSession).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("finds the coordinator by its role label regardless of the agent name", async () => {
    const { clients } = environment();
    const { agents } = await clients.agents.listAgents({ namespace: "agentos" });
    const coordinator = agents.find((agent) => agent.ref?.name === "coordinator");
    if (!coordinator?.ref) throw new Error("Coordinator fixture is missing");
    coordinator.ref.name = "duty-lead";
    vi.spyOn(clients.agents, "listAgents").mockResolvedValue(
      create(ListAgentsResponseSchema, { agents }),
    );
    vi.spyOn(clients.agents, "getAgent").mockResolvedValue(
      create(GetAgentResponseSchema, { agent: coordinator }),
    );
    const createSession = vi.spyOn(clients.sessions, "createSession");
    const invoke = vi.fn(async () => ({ content: [] }));
    await coordinatorDelegation(clients, "agentos", invoke)(message());
    expect(createSession.mock.calls[0]?.[0]).toEqual({
      agent: { namespace: "agentos", name: "duty-lead" },
      requestId: "handoff-request",
    });
  });

  it("requires exactly one coordinator in the workspace", async () => {
    const { clients } = environment();
    const { agents } = await clients.agents.listAgents({ namespace: "agentos" });
    const coordinator = agents.find((agent) => agent.ref?.name === "coordinator");
    if (!coordinator) throw new Error("Coordinator fixture is missing");
    const invoke = vi.fn(async () => ({ content: [] }));
    for (const team of [
      agents.filter((agent) => agent !== coordinator),
      [...agents, coordinator],
    ]) {
      vi.spyOn(clients.agents, "listAgents").mockResolvedValueOnce(
        create(ListAgentsResponseSchema, { agents: team }),
      );
      await expect(coordinatorDelegation(clients, "agentos", invoke)(message())).rejects.toThrow(
        /exactly one coordinator/,
      );
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("checks the role before creating a session for the configured coordinator", async () => {
    const { clients } = environment();
    const response = await clients.agents.getAgent({
      ref: { namespace: "agentos", name: "coordinator" },
    });
    if (!response.agent?.resource?.value) throw new Error("Coordinator fixture is missing");
    response.agent.resource.value.metadata = { labels: { "agentos.dev/role": "inspection" } };
    vi.spyOn(clients.agents, "getAgent").mockResolvedValue(response);
    const createSession = vi.spyOn(clients.sessions, "createSession");
    const invoke = vi.fn(async () => ({ content: [] }));
    await expect(coordinatorDelegation(clients, "agentos", invoke)(message())).rejects.toThrow(
      /coordinator/,
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
