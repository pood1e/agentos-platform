import { create } from "@bufbuild/protobuf";
import { TaskState } from "../../gen/a2a_pb.js";
import type { ListTasksRequest } from "../../gen/agentos/console/v1/console_service_pb.js";
import { ConversationSummarySchema } from "../../gen/agentos/console/v1/conversation_pb.js";
import type { ExecutionBinding } from "../../gen/agentos/execution/v1/identity_pb.js";
import type { ExecutionStore } from "../authorization/store.js";
import type { TaskGraph } from "./graph.js";
import { type PageRequest, pageOf } from "./page.js";
import { terminal } from "./state.js";
import { taskTree } from "./tree.js";
import { conversationProgress } from "./views/conversation-work.js";
import { pendingApproval, stamp } from "./views/runs.js";
import { taskSummary } from "./views/task.js";

/** Personal executions, plus service work for administrators. */
export interface Viewer {
  subject: string;
  administrator: boolean;
  systemOnly?: boolean;
}

export function listings(
  load: (bindings: ExecutionBinding[]) => Promise<TaskGraph>,
  inventory: ExecutionStore["inventory"],
) {
  const visible = async (viewer: Viewer) =>
    load(
      await inventory({
        subject: viewer.subject,
        services: viewer.administrator,
        systemOnly: viewer.systemOnly,
      }),
    );
  return {
    async conversations(viewer: Viewer, agentId: string, request: PageRequest) {
      const graph = await visible(viewer);
      const needle = request.query.trim().toLowerCase();
      const rows = graph
        .sessions()
        .filter((session) => session.agentId === agentId)
        .filter((session) =>
          [session.name, ...graph.contextEntries(session.id).map((entry) => entry.prompt)]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
        .map((session) => {
          const progress = conversationProgress(graph, session.id);
          return {
            id: session.id,
            time: Math.max(session.updatedAt ?? 0, progress.updatedAt),
            title: session.name,
            state: progress.state,
          };
        })
        .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const page = pageOf(rows, request, `conversations:${agentId}`, (row) => row);
      return {
        conversations: page.items.map((row) =>
          create(ConversationSummarySchema, {
            contextId: row.id,
            title: row.title,
            state: row.state,
            updatedAt: stamp(row.time || undefined),
          }),
        ),
        totalSize: page.totalSize,
        nextPageToken: page.nextPageToken,
      };
    },
    async operations(
      viewer: Viewer,
      request: PageRequest & Partial<Pick<ListTasksRequest, "states" | "engineer">>,
    ) {
      const graph = await visible(viewer);
      const states = [...new Set(request.states ?? [])].sort((a, b) => a - b);
      const engineer = request.engineer ?? "";
      const needle = request.query.trim().toLowerCase();
      const rows = graph
        .relations()
        .roots.flatMap((root) => {
          const tree = taskTree(graph, root.id);
          if (!tree || (engineer && !tree.entries.some((entry) => entry.agentId === engineer)))
            return [];
          const summary = taskSummary(graph, tree);
          if (states.length && !states.includes(summary.state)) return [];
          if (![summary.prompt, root.id].join(" ").toLowerCase().includes(needle)) return [];
          return [{ id: root.id, time: tree.updatedAt ?? 0, summary }];
        })
        .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const scope = `tasks:${JSON.stringify([states, engineer, viewer.systemOnly === true])}`;
      const page = pageOf(rows, request, scope, (row) => row);
      return {
        tasks: page.items.map((row) => row.summary),
        totalSize: page.totalSize,
        nextPageToken: page.nextPageToken,
      };
    },
    async agentActivity(viewer: Viewer) {
      const graph = await visible(viewer);
      return new Map(
        graph.agents().map((agent) => {
          const entries = graph.agentEntries(agent.id);
          return [
            agent.id,
            {
              active: entries.filter((entry) => !terminal(entry.state)).length,
              calls: entries.reduce((total, entry) => total + entry.calls.length, 0),
              approval: entries.some((entry) => !terminal(entry.state) && pendingApproval(entry)),
              interrupted: entries.some((entry) =>
                [TaskState.INPUT_REQUIRED, TaskState.AUTH_REQUIRED].includes(entry.state),
              ),
            },
          ];
        }),
      );
    },
  };
}
