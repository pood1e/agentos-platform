import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { clone, create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  type Message,
  type StreamResponse,
  StreamResponseSchema,
  type Task,
  TaskSchema,
  TaskState,
  TaskStatusSchema,
} from "../../gen/a2a_pb.js";
import {
  type AgentTemplate,
  AgentTemplateSchema,
} from "../../gen/kagent/api/v1/agent_templates_pb.js";
import type { Agent } from "../../gen/kagent/api/v1/agents_pb.js";
import {
  SessionAuthoritySchema,
  type TaskExecution,
  TaskExecutionSchema,
  TaskRelation,
} from "../../gen/kagent/api/v1/execution_pb.js";
import { type Session, SessionSchema } from "../../gen/kagent/api/v1/sessions_pb.js";
import { agentKey } from "../../server/kagent/resources.js";
import { createdAtKey } from "../../server/read-model/decode/messages.js";
import { terminal } from "../../server/read-model/state.js";
import { conflict } from "../../server/shared/errors.js";
import { object } from "../../shared/json.js";
import { fixtureExecution } from "../fixtures/kagent.js";
import { execute, reply } from "./behavior.js";
import { templates, toolServers } from "./catalog.js";
import { FakeMemory } from "./memory.js";
import { FakeResources } from "./resources.js";

/** In-memory kagent with deterministic agent behavior for tests and local development. */
export class FakeKagent {
  readonly agents: Agent[];
  readonly sessions = new Map<string, Session>();
  readonly workflowDefinitions = new Map<
    string,
    { document: Uint8Array; preparedRevision: string; sha256: string }
  >();
  readonly executions = new Map<string, TaskExecution>();
  readonly sessionParents = new Map<string, string>();
  readonly credentials = new Map<string, string>();
  renewable = true;
  readonly tasks = new Map<string, Task>();
  readonly templates = new Map(templates().map((item) => [item.ref?.name ?? "", item]));
  readonly toolServers = toolServers();
  readonly resources: FakeResources;
  readonly memory = new FakeMemory();
  readonly received: Message[] = [];
  readonly listed: { tenant: string; incremental: boolean; returned: number }[] = [];
  readonly fetched: string[] = [];
  readonly catalogReads: { method: string; returned: number }[] = [];
  private requests = new Map<string, string>();
  private updates = new EventEmitter().setMaxListeners(0);
  private clock = 0;
  private lifetime = new AbortController();

  constructor(fixtures: { agents: Agent[]; sessions: Session[]; tasks: Task[] }) {
    this.agents = fixtures.agents;
    this.load(fixtures);
    this.resources = new FakeResources(this);
  }

  /** Replaces sessions and tasks; restored tasks get a new status time so readers see a change. */
  load(fixtures: { sessions: Session[]; tasks: Task[] }): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.requests.clear();
    this.sessions.clear();
    this.workflowDefinitions.clear();
    this.tasks.clear();
    this.executions.clear();
    for (const session of fixtures.sessions) {
      session.creator = "user:operator";
      this.sessions.set(session.id, session);
    }
    for (const task of fixtures.tasks) {
      if (task.status && !terminal(task.status.state))
        task.status.timestamp = timestampFromMs(this.now());
      this.tasks.set(task.id, task);
      this.executions.set(task.id, fixtureExecution(task));
    }
    for (const session of this.sessions.values()) {
      const execution = [...this.executions.values()].find((e) => e.task?.sessionId === session.id);
      session.authority = create(SessionAuthoritySchema, {
        sessionId: session.id,
        initiatorId: session.creator,
        rootSessionId: execution?.root?.sessionId ?? session.id,
        workspaceUid: `${session.agent?.namespace}-uid`,
        scopeCeiling: { scopes: [] },
      });
    }
  }

  now(): number {
    this.clock = Math.max(this.clock + 1, Date.now());
    return this.clock;
  }

  tenantOf = (task: Task) => agentKey(this.sessions.get(task.contextId)?.agent);

  task(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new ConnectError("task not found", Code.NotFound);
    return task;
  }

  update(task: Task, state: TaskState, message?: Message): void {
    task.status = create(TaskStatusSchema, {
      state,
      timestamp: timestampFromMs(this.now()),
      message,
    });
    this.tasks.set(task.id, task);
    if (!this.executions.has(task.id)) {
      const parentSession = this.sessionParents.get(task.contextId);
      const parent = [...this.tasks.values()].filter((t) => t.contextId === parentSession).at(-1);
      const ref = { taskId: task.id, sessionId: task.contextId };
      this.executions.set(
        task.id,
        create(TaskExecutionSchema, {
          task: ref,
          root: parent ? this.executions.get(parent.id)?.root : ref,
          parent: parent ? { taskId: parent.id, sessionId: parent.contextId } : undefined,
          relation: parent ? TaskRelation.DELEGATION : TaskRelation.ROOT,
        }),
      );
    }
    this.updates.emit(task.id, task);
  }

  createSession(agent: { namespace: string; name: string }, requestId: string, name: string) {
    const previous = this.requests.get(requestId);
    const existing = this.sessions.get(previous ?? "");
    if (existing) return existing;
    if (previous)
      throw new ConnectError("request belongs to a deleted session", Code.FailedPrecondition);
    const session = create(SessionSchema, {
      id: randomUUID(),
      creator: "user:operator",
      agent,
      name,
      createdAt: timestampFromMs(this.now()),
      updatedAt: timestampFromMs(this.now()),
    });
    this.requests.set(requestId, session.id);
    session.authority = create(SessionAuthoritySchema, {
      sessionId: session.id,
      rootSessionId: session.id,
      initiatorId: session.creator,
      workspaceUid: `${agent.namespace}-uid`,
    });
    this.sessions.set(session.id, session);
    const value = this.agents.find((item) => agentKey(item.ref) === agentKey(agent))?.resource
      ?.value;
    const spec = object(value?.spec);
    const templateName = object(object(spec.template).ref).name;
    const template =
      typeof templateName === "string"
        ? this.templates.get(templateName)?.resource?.value?.spec
        : object(object(spec.template).inline);
    const source = object(object(template).workflowFrom);
    if (typeof source.name === "string" && typeof source.key === "string") {
      const document = object(this.resources.get("configmaps", source.name).data)[source.key];
      if (typeof document === "string")
        this.workflowDefinitions.set(session.id, {
          document: new TextEncoder().encode(document),
          preparedRevision: "workflow-test-revision",
          sha256: "test-digest",
        });
    }
    return session;
  }

  async createChildSession(
    parentId: string,
    agent: { namespace: string; name: string },
    name: string,
  ) {
    const { signal } = this.lifetime;
    const parent = this.sessions.get(parentId);
    if (!parent) throw new Error("Fixture parent session missing");
    const child = this.createSession(agent, randomUUID(), name);
    this.sessionParents.set(child.id, parent.id);
    child.authority = create(SessionAuthoritySchema, {
      sessionId: child.id,
      initiatorId: parent.creator,
      parentSessionId: parent.id,
      rootSessionId: parent.authority?.rootSessionId ?? parent.id,
      workspaceUid: parent.authority?.workspaceUid,
    });
    signal.throwIfAborted();
    return child;
  }

  /** Accepts a message the way kagent does, deduplicating initial messages by ID. */
  accept(message: Message): Task {
    this.received.push(message);
    if (message.taskId) return reply(this, this.task(message.taskId), message);
    const accepted = [...this.tasks.values()].find(
      (task) =>
        task.contextId === message.contextId &&
        task.history.some((item) => item.messageId === message.messageId),
    );
    if (accepted) return accepted;
    const task = create(TaskSchema, {
      id: randomUUID(),
      contextId: message.contextId,
      history: [message],
      metadata: { [createdAtKey]: new Date(this.now()).toISOString() },
    });
    this.update(task, TaskState.WORKING);
    const { signal } = this.lifetime;
    setTimeout(() => {
      if (signal.aborted) return;
      void execute(this, task, message).catch((error) => {
        if (!signal.aborted) throw error;
      });
    }, 200);
    return task;
  }

  /** Current task snapshot followed by every change until the task ends. */
  async *follow(id: string, signal: AbortSignal): AsyncGenerator<StreamResponse> {
    let task = this.task(id);
    const snapshot = (value: Task) =>
      create(StreamResponseSchema, { payload: { case: "task", value: clone(TaskSchema, value) } });
    yield snapshot(task);
    while (!terminal(task.status?.state) && !signal.aborted) {
      task = await new Promise<Task>((resolve, reject) => {
        const done = (next: Task) => {
          signal.removeEventListener("abort", abort);
          resolve(next);
        };
        const abort = () => {
          this.updates.off(id, done);
          reject(signal.reason);
        };
        this.updates.once(id, done);
        signal.addEventListener("abort", abort, { once: true });
      });
      yield snapshot(task);
    }
  }

  template(name: string): AgentTemplate {
    const template = this.templates.get(name);
    if (!template) throw new ConnectError("AgentTemplate not found", Code.NotFound);
    return template;
  }

  replaceTemplate(incoming: AgentTemplate): AgentTemplate {
    const existing = this.template(incoming.ref?.name ?? "");
    const metadata = object(existing.resource?.value?.metadata);
    const next = incoming.resource?.value ?? {};
    if (metadata.resourceVersion !== object(next.metadata).resourceVersion)
      throw conflict("configuration.conflict");
    const template = clone(AgentTemplateSchema, incoming);
    if (template.resource?.value)
      template.resource.value.metadata = {
        ...object(next.metadata),
        resourceVersion: String(Number(metadata.resourceVersion) + 1),
      };
    this.templates.set(incoming.ref?.name ?? "", template);
    return template;
  }
}
