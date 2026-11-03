import { create } from "@bufbuild/protobuf";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import {
  type WatchConversationRequest,
  WatchConversationResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey } from "../kagent/resources.js";
import type { McpApps } from "../mcp-apps/service.js";
import { ingest } from "../read-model/entry.js";
import { TaskGraph } from "../read-model/graph.js";
import type { TaskQueries } from "../read-model/queries.js";
import type { TaskStreams } from "../read-model/streams.js";
import { conversation, type FullTask } from "../read-model/views/conversation.js";
import { notFound } from "../shared/errors.js";
import { conversationTranscript } from "./conversation-transcript.js";
import { interactionPermissions } from "./interaction-permissions.js";
import { conversationTarget, viewer, visibleGraph } from "./visibility.js";
import { watchLive } from "./watch.js";

/** Read-only execution snapshots of one conversation, updated from native tasks and live streams. */
export function conversationWatch({
  projection,
  clients,
  apps,
  namespace,
  entryAgent,
}: {
  projection: TaskQueries;
  clients: KagentClients;
  apps: McpApps;
  namespace: string;
  entryAgent: string;
}) {
  const { canOperate, approvalsFor } = interactionPermissions(projection, clients);

  async function liveGraph(
    request: WatchConversationRequest,
    identity: UserIdentity,
    streams: TaskStreams,
    signal: AbortSignal,
  ) {
    if (!request.contextId) return new TaskGraph([], [], await projection.agents(signal));
    const tree = await visibleGraph(
      projection,
      viewer(identity),
      { contextId: request.contextId },
      signal,
    );
    if (tree?.session(request.contextId)?.agentId !== agentKey(request.agent))
      throw notFound("chat.invalidConversation");
    streams.follow(tree.all());
    // Live streams are fresher than the projection while their tasks run.
    return new TaskGraph(
      tree.all().map((entry) => {
        const task = streams.task(entry.id);
        return task ? ingest(task, entry.agentId, entry.execution) : entry;
      }),
      tree.sessions(),
      tree.agents(),
    );
  }

  return (request: WatchConversationRequest, identity: UserIdentity, signal: AbortSignal) => {
    conversationTarget(namespace, entryAgent, request.agent, identity, request.contextId);
    return watchLive(
      projection,
      clients,
      WatchConversationResponseSchema,
      signal,
      async (streams) => {
        const fullTask: FullTask = async (entry) =>
          streams.task(entry.id) ?? projection.fullTask(entry);
        const graph = await liveGraph(request, identity, streams, signal);
        const view = await conversation(graph, request.agent, request.contextId, fullTask);
        await apps.project(view, graph, fullTask);
        view.operate =
          !request.contextId || (await canOperate(request.contextId, identity.subject));
        if (view.interactions.length)
          await approvalsFor(view.interactions, identity.subject, view.operate);
        return create(WatchConversationResponseSchema, {
          conversation: conversationTranscript(view),
        });
      },
    );
  };
}
