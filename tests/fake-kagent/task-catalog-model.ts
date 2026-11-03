import { createHash } from "node:crypto";
import { clone, create } from "@bufbuild/protobuf";
import { type Timestamp, timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import { ActivityState } from "../../gen/agentos/execution/v1/state_pb.js";
import { RuntimeState } from "../../gen/kagent/api/v1/runtime_pb.js";
import {
  CatalogTaskSchema,
  type TaskActivityFilter,
  type TaskCatalogScope,
  TaskCatalogView,
} from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { agentKey } from "../../server/kagent/resources.js";
import { agentInfo, sessionInfo } from "../../server/read-model/agents.js";
import { createdAtKey } from "../../server/read-model/decode/messages.js";
import { ingest, type TaskEntry } from "../../server/read-model/entry.js";
import { TaskGraph } from "../../server/read-model/graph.js";
import { taskActivity, terminal } from "../../server/read-model/state.js";
import { busy, outcomeState, taskTree } from "../../server/read-model/tree.js";
import { conversationWork } from "../../server/read-model/views/conversation-work.js";
import { pendingApproval } from "../../server/read-model/views/runs.js";
import type { FakeKagent } from "./kagent.js";

/** Native conversation status: includes background work, unlike composer availability. */
export function conversationProgress(graph: TaskGraph, contextId: string) {
  const entries = graph.contextEntries(contextId);
  const runs = conversationWork(graph, entries);
  const latest = entries.toSorted(
    (a, b) => (b.createdAt ?? b.statusAt ?? 0) - (a.createdAt ?? a.statusAt ?? 0),
  )[0];
  const tree = latest && taskTree(graph, latest.id);
  const priority = [
    ActivityState.AWAITING_APPROVAL,
    ActivityState.AWAITING_INPUT,
    ActivityState.WORKING,
    ActivityState.SUBMITTED,
  ];
  const state =
    priority.find((state) => runs.some((run) => run.state === state)) ??
    (entries.some((entry) => {
      const work = taskTree(graph, entry.id);
      return work && busy(work);
    })
      ? ActivityState.WORKING
      : tree
        ? taskActivity(outcomeState(tree))
        : ActivityState.IDLE);
  return {
    state,
    updatedAt: Math.max(
      0,
      ...runs.flatMap((run) => (run.updatedAt ? timestampMs(run.updatedAt) : [])),
    ),
  };
}

export function catalogFixture(
  fake: FakeKagent,
  scope: TaskCatalogScope | undefined,
  token: string | null,
) {
  if (!scope) throw new ConnectError("Missing catalog scope", Code.InvalidArgument);
  const bound = token?.startsWith("Bearer kagent-session.")
    ? fake.credentials.get(token.slice(7))
    : undefined;
  const subject = token?.startsWith("Bearer user:") ? token.slice(7) : "user:operator";
  if (token === "Bearer denied-reader")
    throw new ConnectError("Read revoked", Code.PermissionDenied);
  if (bound && scope.visibility.case !== "sessionTreeAnchor")
    throw new ConnectError("Bound scope denied", Code.PermissionDenied);
  const anchorId = scope.visibility.case === "sessionTreeAnchor" ? scope.visibility.value : "";
  const anchor = anchorId ? fake.sessions.get(anchorId) : undefined;
  if (anchorId && (!anchor || anchor.state === RuntimeState.DELETED))
    throw new ConnectError("Session not found", Code.NotFound);
  if (bound && (bound !== anchorId || !fake.renewable))
    throw new ConnectError("Bound scope denied", Code.PermissionDenied);
  const root = anchor?.authority?.rootSessionId || anchorId;
  const sessions = [...fake.sessions.values()].filter(
    (session) =>
      session.state !== RuntimeState.DELETED &&
      session.agent?.namespace === scope.namespace &&
      (anchorId
        ? (session.authority?.rootSessionId || session.id) === root
        : scope.visibility.case === "otherInitiators"
          ? (session.authority?.initiatorId || session.creator) !== subject
          : session.creator === subject),
  );
  const known = new Map(sessions.map((session) => [session.id, session]));
  const entries = [...fake.tasks.values()].flatMap((task) => {
    const session = known.get(task.contextId),
      execution = fake.executions.get(task.id);
    return session && execution ? [ingest(task, agentKey(session.agent), execution)] : [];
  });
  const templates = new Map(
    [...fake.templates.values()].map((template) => [agentKey(template.ref), template]),
  );
  const members = fake.agents.map((agent) => agentInfo(agent, templates));
  return { sessions, graph: new TaskGraph(entries, sessions.map(sessionInfo), members), subject };
}

export function catalogRow(
  fake: FakeKagent,
  entry: TaskEntry,
  view: TaskCatalogView,
  background = false,
) {
  const task = clone(TaskSchema, fake.task(entry.id));
  if (entry.createdAt !== undefined) {
    task.metadata ??= {};
    task.metadata[createdAtKey] = new Date(entry.createdAt).toISOString();
  }
  if (
    view === TaskCatalogView.SUMMARY ||
    (view === TaskCatalogView.ACTIVE_DETAILS && terminal(entry.state))
  ) {
    task.history = [];
    task.artifacts = [];
  }
  return create(CatalogTaskSchema, {
    task,
    execution: entry.execution,
    initialPrompt: entry.prompt,
    pendingToolApproval: pendingApproval(entry),
    background,
  });
}

const states = new Map([
  [ActivityState.SUBMITTED, TaskState.SUBMITTED],
  [ActivityState.WORKING, TaskState.WORKING],
  [ActivityState.AWAITING_APPROVAL, TaskState.INPUT_REQUIRED],
  [ActivityState.AWAITING_INPUT, TaskState.INPUT_REQUIRED],
  [ActivityState.SUCCEEDED, TaskState.COMPLETED],
  [ActivityState.FAILED, TaskState.FAILED],
  [ActivityState.REJECTED, TaskState.REJECTED],
  [ActivityState.CANCELED, TaskState.CANCELED],
  [ActivityState.UNOBSERVED, TaskState.UNSPECIFIED],
]);
export const nativeActivity = (state: ActivityState, updatedAt?: Timestamp) => ({
  state: states.get(state),
  pendingToolApproval: state === ActivityState.AWAITING_APPROVAL,
  updatedAt,
});
export const matchesActivity = (
  state: TaskState,
  approval: boolean,
  filters: TaskActivityFilter[],
) =>
  !filters.length ||
  filters.some(
    (filter) =>
      (filter.state === undefined || filter.state === state) &&
      (filter.pendingToolApproval === undefined || filter.pendingToolApproval === approval),
  );

export function catalogPage<T>(
  rows: T[],
  request: { page?: { limit: number; pageToken: string } },
  key: unknown,
  position: (row: T) => { id: string; time: number },
) {
  const fingerprint = createHash("sha256").update(JSON.stringify(key)).digest("hex");
  let selected = rows;
  if (request.page?.pageToken) {
    let cursor: { fingerprint: string; id: string; time: number };
    try {
      cursor = JSON.parse(Buffer.from(request.page.pageToken, "base64url").toString());
    } catch {
      throw new ConnectError("pagination.invalidPage", Code.InvalidArgument);
    }
    if (cursor.fingerprint !== fingerprint)
      throw new ConnectError("pagination.invalidPage", Code.InvalidArgument);
    selected = rows.filter(
      (row) =>
        position(row).time < cursor.time ||
        (position(row).time === cursor.time && position(row).id.localeCompare(cursor.id) > 0),
    );
  }
  const items = selected.slice(0, request.page?.limit || 12),
    last = items.at(-1);
  return {
    items,
    totalSize: rows.length,
    page: {
      nextPageToken:
        last && items.length < selected.length
          ? Buffer.from(
              JSON.stringify({ fingerprint, id: position(last).id, time: position(last).time }),
            ).toString("base64url")
          : "",
    },
  };
}
export const time = (value?: Timestamp) => (value ? timestampMs(value) : 0);
export const sortedFilters = (filters: TaskActivityFilter[]) =>
  filters
    .map((f) => [f.state ?? null, f.pendingToolApproval ?? null])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function backgroundOf(graph: TaskGraph, entry: TaskEntry, boundary: Set<string>) {
  let current: TaskEntry | undefined = entry,
    background = false;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    background ||= current.execution?.background ?? false;
    const parent = graph.entry(current.execution?.parent?.taskId ?? "");
    if (!parent || boundary.has(parent.agentId)) break;
    current = parent;
  }
  return background;
}
