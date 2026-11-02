import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type {
  ListAgentRunsRequest,
  ListTasksRequest,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import { ConversationSummarySchema } from "../../gen/agentos/console/v1/conversation_pb.js";
import { ExecutionGraphSchema } from "../../gen/agentos/console/v1/execution_pb.js";
import { TaskSummarySchema } from "../../gen/agentos/console/v1/task_pb.js";
import { TaskCatalogView } from "../../gen/kagent/api/v1/task_catalog_pb.js";
import { shortTitle } from "../../shared/title.js";
import type { KagentClients } from "../kagent/clients.js";
import { type AgentInfo, agentKey, agentRef, systemTemplates } from "./agents.js";
import { catalogGraph } from "./catalog-entries.js";
import { activityFilters, catalogScope, catalogState, type Viewer } from "./catalog-state.js";
import { millis } from "./decode/messages.js";
import type { PageRequest } from "./page.js";
import { agentSummaries } from "./views/agents.js";
import { executionGraph } from "./views/execution.js";
import { agentRun } from "./views/run.js";
import { stamp } from "./views/runs.js";

export type { Viewer } from "./catalog-state.js";

const rpc = { timeoutMs: 10_000 };
const page = (request: Pick<PageRequest, "pageSize" | "pageToken">) => ({
  limit: request.pageSize || 12,
  pageToken: request.pageToken,
});
const boundaries = (agents: AgentInfo[]) =>
  agents
    .filter((agent) => systemTemplates.has(agent.templateName))
    .map((agent) => agent.id)
    .sort()
    .map(agentRef);
const count = (value: number | bigint) => {
  if (value < 0 || value > 2_147_483_647)
    throw new ConnectError("Native activity count exceeds the console range", Code.OutOfRange);
  return Number(value);
};

/** Queries the authorized native catalog before projecting console display types. */
export function listings({
  workspace,
  clients,
  agents,
}: {
  workspace: string;
  clients: KagentClients;
  agents(): Promise<AgentInfo[]>;
}) {
  return {
    async conversations(viewer: Viewer, agentId: string, request: PageRequest) {
      const result = await clients.catalog.listSessionActivity(
        {
          scope: catalogScope(workspace, viewer),
          agent: agentRef(agentId),
          page: page(request),
          query: request.query,
        },
        rpc,
      );
      return {
        conversations: result.sessions.map(({ session, activity }) => {
          if (!session?.id || agentKey(session.agent) !== agentId)
            throw new ConnectError("Native conversation unavailable", Code.FailedPrecondition);
          return create(ConversationSummarySchema, {
            contextId: session.id,
            title: session.name,
            state: catalogState(activity, true),
            updatedAt: stamp(millis(activity?.updatedAt) || undefined),
          });
        }),
        totalSize: result.totalSize,
        nextPageToken: result.page?.nextPageToken ?? "",
      };
    },
    async operations(
      viewer: Viewer,
      request: PageRequest &
        Partial<Pick<ListTasksRequest, "states" | "agent" | "includeExecutionGraph">>,
    ) {
      const scope = catalogScope(workspace, viewer);
      const activities = activityFilters(request.states ?? []);
      const selectedAgent = request.agent;
      const empty = () => ({
        tasks: [],
        totalSize: 0,
        nextPageToken: "",
        executionGraph: request.includeExecutionGraph ? create(ExecutionGraphSchema) : undefined,
      });
      if (
        (request.states?.length && !activities.length) ||
        (selectedAgent && (selectedAgent.namespace !== workspace || !selectedAgent.name))
      )
        return empty();
      const members = await agents();
      const result = await clients.catalog.listTaskGroups(
        {
          scope,
          page: page(request),
          query: request.query,
          activities,
          agent: selectedAgent,
          boundaryAgents: boundaries(members),
          view: request.includeExecutionGraph
            ? TaskCatalogView.ACTIVE_DETAILS
            : TaskCatalogView.SUMMARY,
        },
        rpc,
      );
      const graph = catalogGraph(workspace, result, members);
      const tasks = result.groups.map(({ root, initiator, activity }) => {
        const entry = root && graph.entry(root.taskId);
        const startedBy = initiator && graph.entry(initiator.taskId);
        if (
          !entry ||
          entry.contextId !== root?.sessionId ||
          (initiator &&
            (startedBy?.contextId !== initiator.sessionId ||
              entry.execution?.parent?.taskId !== initiator.taskId ||
              entry.execution.parent.sessionId !== initiator.sessionId))
        )
          throw new ConnectError("Native task group unavailable", Code.FailedPrecondition);
        const prompt = startedBy?.prompt || entry.prompt;
        return create(TaskSummarySchema, {
          id: entry.id,
          title: shortTitle(prompt) || entry.id,
          prompt,
          state: catalogState(activity),
          updatedAt: stamp(millis(activity?.updatedAt)),
          conversationContextId: startedBy?.contextId ?? "",
          agent: agentRef(entry.agentId),
          contextId: entry.contextId,
        });
      });
      return {
        tasks,
        totalSize: result.totalSize,
        nextPageToken: result.page?.nextPageToken ?? "",
        executionGraph: request.includeExecutionGraph
          ? executionGraph(
              graph,
              tasks.map((task) => task.id),
            )
          : undefined,
      };
    },
    async agentSummaries(viewer: Viewer) {
      const [members, result] = await Promise.all([
        agents(),
        clients.catalog.listAgentActivity({ scope: catalogScope(workspace, viewer) }, rpc),
      ]);
      return agentSummaries(
        members,
        new Map(
          result.agents.map((activity) => [
            agentKey(activity.agent),
            {
              active: count(activity.activeTasks),
              calls: count(activity.toolCalls),
              working: activity.working,
              approval: activity.pendingToolApproval,
              interrupted: activity.interrupted,
            },
          ]),
        ),
      );
    },
    async agentRuns(viewer: Viewer, request: ListAgentRunsRequest) {
      const scope = catalogScope(workspace, viewer);
      const ref = request.agent;
      const activities = activityFilters(request.states);
      if (
        !ref ||
        ref.namespace !== workspace ||
        !ref.name ||
        (request.states.length && !activities.length)
      )
        return { runs: [], nextPageToken: "" };
      const members = await agents();
      const result = await clients.catalog.listTaskRecords(
        {
          scope,
          agent: ref,
          page: page(request),
          activities,
          boundaryAgents: boundaries(members),
          view: TaskCatalogView.ACTIVE_DETAILS,
        },
        rpc,
      );
      const graph = catalogGraph(workspace, result, members);
      return {
        runs: result.tasks.map((row) => {
          const entry = row.task && graph.entry(row.task.id);
          if (!entry || entry.agentId !== agentKey(ref))
            throw new ConnectError("Native Agent record unavailable", Code.FailedPrecondition);
          return agentRun(entry, row.background);
        }),
        nextPageToken: result.page?.nextPageToken ?? "",
      };
    },
  };
}
