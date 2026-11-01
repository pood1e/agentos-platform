import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";
import { TaskState } from "../../gen/a2a_pb.js";
import { TaskCatalogService } from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { agentKey } from "../../server/read-model/agents.js";
import { terminal } from "../../server/read-model/state.js";
import { taskTree } from "../../server/read-model/tree.js";
import { conversationProgress } from "../../server/read-model/views/conversation-work.js";
import { pendingApproval, runState } from "../../server/read-model/views/runs.js";
import { taskSummary } from "../../server/read-model/views/task.js";
import type { FakeKagent } from "./kagent.js";
import {
  backgroundOf,
  catalogFixture,
  catalogPage,
  catalogRow,
  matchesActivity,
  nativeActivity,
  sortedFilters,
  time,
} from "./task-catalog-model.js";

/** The native catalog contract over recordings; SQL plans are verified by kagent. */
export function taskCatalogRoutes(fake: FakeKagent, router: ConnectRouter) {
  router.service(TaskCatalogService, {
    listTaskGroups(request, context) {
      const fixture = catalogFixture(
        fake,
        request.scope,
        context.requestHeader.get("authorization"),
      );
      const boundary = new Set(request.boundaryAgents.map(agentKey)),
        graph = fixture.graph;
      const needle = request.query.trim().toLowerCase();
      const rows = graph
        .all()
        .flatMap((entry) => {
          const parent = graph.entry(entry.execution?.parent?.taskId ?? "");
          if (boundary.has(entry.agentId) || (parent && !boundary.has(parent.agentId))) return [];
          const tree = taskTree(graph, entry.id);
          if (
            !tree ||
            (request.agent &&
              !tree.entries.some((task) => task.agentId === agentKey(request.agent)))
          )
            return [];
          const summary = taskSummary(graph, tree),
            activity = nativeActivity(summary.state, summary.updatedAt);
          if (
            !matchesActivity(
              activity.state ?? TaskState.UNSPECIFIED,
              activity.pendingToolApproval,
              request.activities,
            ) ||
            ![summary.prompt, entry.id].join(" ").toLowerCase().includes(needle)
          )
            return [];
          return [{ entry, parent, tree, activity, id: entry.id, time: time(summary.updatedAt) }];
        })
        .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const selected = catalogPage(
        rows,
        request,
        [
          "groups",
          fixture.subject,
          request.scope,
          sortedFilters(request.activities),
          request.query,
          agentKey(request.agent),
          [...boundary].sort(),
        ],
        (row) => row,
      );
      const included = new Map(
        selected.items.flatMap(({ tree, parent }) =>
          [...tree.entries, ...(parent ? [parent] : [])].map((entry) => [entry.id, entry] as const),
        ),
      );
      fake.catalogReads.push({ method: "ListTaskGroups", returned: included.size });
      return {
        groups: selected.items.map(({ entry, parent, activity }) => ({
          root: { taskId: entry.id, sessionId: entry.contextId },
          initiator: parent ? { taskId: parent.id, sessionId: parent.contextId } : undefined,
          activity,
        })),
        tasks: [...included.values()].map((entry) => catalogRow(fake, entry, request.view)),
        sessions: fixture.sessions.filter((session) =>
          [...included.values()].some((e) => e.contextId === session.id),
        ),
        totalSize: selected.totalSize,
        page: selected.page,
      };
    },
    listTaskRecords(request, context) {
      const fixture = catalogFixture(
        fake,
        request.scope,
        context.requestHeader.get("authorization"),
      );
      const boundary = new Set(request.boundaryAgents.map(agentKey));
      const rows = fixture.graph
        .all()
        .filter(
          (entry) =>
            (!request.agent || entry.agentId === agentKey(request.agent)) &&
            matchesActivity(entry.state, pendingApproval(entry), request.activities),
        )
        .map((entry) => ({ entry, id: entry.id, time: entry.statusAt ?? entry.createdAt ?? 0 }))
        .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const selected = catalogPage(
        rows,
        request,
        [
          "records",
          fixture.subject,
          request.scope,
          agentKey(request.agent),
          sortedFilters(request.activities),
          [...boundary].sort(),
        ],
        (row) => row,
      );
      const anchor =
        request.scope?.visibility.case === "sessionTreeAnchor"
          ? request.scope.visibility.value
          : "";
      fake.catalogReads.push({ method: "ListTaskRecords", returned: selected.items.length });
      return {
        tasks: selected.items.map(({ entry }) =>
          catalogRow(fake, entry, request.view, backgroundOf(fixture.graph, entry, boundary)),
        ),
        sessions: fixture.sessions.filter(
          (session) =>
            session.id === anchor ||
            selected.items.some((row) => row.entry.contextId === session.id),
        ),
        totalSize: selected.totalSize,
        page: selected.page,
      };
    },
    listSessionActivity(request, context) {
      const fixture = catalogFixture(
        fake,
        request.scope,
        context.requestHeader.get("authorization"),
      );
      const needle = request.query.trim().toLowerCase();
      const rows = fixture.sessions
        .filter((session) => agentKey(session.agent) === agentKey(request.agent))
        .filter((session) =>
          [session.name, ...fixture.graph.contextEntries(session.id).map((entry) => entry.prompt)]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
        .map((session) => {
          const progress = conversationProgress(fixture.graph, session.id);
          const updated = Math.max(time(session.updatedAt), progress.updatedAt);
          return {
            id: session.id,
            time: updated,
            session,
            activity: nativeActivity(
              progress.state,
              updated ? timestampFromMs(updated) : undefined,
            ),
          };
        })
        .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
      const selected = catalogPage(
        rows,
        request,
        ["sessions", fixture.subject, request.scope, agentKey(request.agent), request.query],
        (row) => row,
      );
      fake.catalogReads.push({ method: "ListSessionActivity", returned: selected.items.length });
      return {
        sessions: selected.items.map(({ session, activity }) => ({ session, activity })),
        totalSize: selected.totalSize,
        page: selected.page,
      };
    },
    listAgentActivity(request, context) {
      const fixture = catalogFixture(
        fake,
        request.scope,
        context.requestHeader.get("authorization"),
      );
      fake.catalogReads.push({
        method: "ListAgentActivity",
        returned: fixture.graph.agents().length,
      });
      return {
        agents: fixture.graph.agents().map((agent) => {
          const entries = fixture.graph.agentEntries(agent.id),
            active = entries.filter((entry) => !terminal(entry.state));
          return {
            agent: { namespace: agent.id.split("/")[0], name: agent.id.split("/")[1] },
            activeTasks: active.length,
            toolCalls: BigInt(entries.reduce((count, entry) => count + entry.calls.length, 0)),
            working: active.some((entry) => [1, 2].includes(runState(entry))),
            pendingToolApproval: active.some(pendingApproval),
            interrupted: active.some((entry) => [6, 8].includes(entry.state)),
          };
        }),
      };
    },
  });
}
