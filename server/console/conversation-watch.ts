import { create, type MessageShape } from "@bufbuild/protobuf";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import {
  type WatchConversationRequest,
  WatchConversationResponseSchema,
} from "../../gen/agentos/console/v1/console_service_pb.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentKey } from "../kagent/resources.js";
import type { McpApps } from "../mcp-apps/service.js";
import type { AgentInfo } from "../read-model/agents.js";
import { ingest } from "../read-model/entry.js";
import { TaskGraph } from "../read-model/graph.js";
import type { TaskQueries, TreeSnapshot } from "../read-model/queries.js";
import { settled } from "../read-model/state.js";
import type { TaskStreams } from "../read-model/streams.js";
import { conversation, type FullTask } from "../read-model/views/conversation.js";
import { notFound } from "../shared/errors.js";
import { conversationTranscript } from "./conversation-transcript.js";
import { interactionPermissions } from "./interaction-permissions.js";
import { conversationTarget, viewer, visibleAnchor } from "./visibility.js";
import { watchLive } from "./watch.js";

// Text deltas arrive several times per second; live streams carry them between catalog reads.
const runningCatalogAge = 2_000;
// Agent names and readiness have no change signal, so they bound how stale a settled view may be.
const settledViewAge = 30_000;

type Response = MessageShape<typeof WatchConversationResponseSchema>;

/** The last built view. A settled view keeps no payloads; it stays valid while its revision holds. */
interface Observation {
  catalogAt: number;
  transitions: number;
  response: Response;
  revision: string;
  operate: boolean;
  running?: TreeSnapshot;
}

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
  const { canOperate, approvalsFor } = interactionPermissions(clients);

  async function readTree(
    request: WatchConversationRequest,
    identity: UserIdentity,
    members: AgentInfo[],
    signal: AbortSignal,
  ): Promise<TreeSnapshot> {
    const { contextId } = request;
    if (!contextId)
      return { graph: new TaskGraph([], [], members), tasks: new Map(), revision: "" };
    const anchor = await visibleAnchor(projection, viewer(identity), { contextId }, signal);
    const snapshot = anchor && (await projection.snapshot(anchor, members, signal));
    if (!snapshot || snapshot.graph.session(contextId)?.agentId !== agentKey(request.agent))
      throw notFound("chat.invalidConversation");
    return snapshot;
  }

  return async function* (
    request: WatchConversationRequest,
    identity: UserIdentity,
    signal: AbortSignal,
  ) {
    const { contextId } = request;
    conversationTarget(namespace, entryAgent, request.agent, contextId);
    let observed: Observation | undefined;
    let members: { at: number; value: AgentInfo[] } | undefined;
    let changedHere = false;
    const release = projection.onChange(() => {
      changedHere = true;
    });

    const currentMembers = async () => {
      if (!members || Date.now() - members.at >= settledViewAge)
        members = { at: Date.now(), value: await projection.agents(signal) };
      return members.value;
    };
    const operable = async () => !contextId || (await canOperate(contextId, identity.subject));

    /** Any failure falls through to the full read, which reports it with its proper error. */
    const stillCurrent = async ({ revision, operate }: Observation) => {
      if (!contextId) return true;
      try {
        const [current, allowed] = await Promise.all([
          projection.treeRevision(contextId, signal),
          operable(),
        ]);
        return current === revision && allowed === operate;
      } catch {
        return false;
      }
    };

    /** Text deltas reuse the running tree; new work here or a state change needs the catalog. */
    const reusableTree = (streams: TaskStreams, age: number) =>
      !changedHere && observed?.transitions === streams.transitions && age < runningCatalogAge
        ? observed.running
        : undefined;

    async function build(streams: TaskStreams) {
      const age = observed ? Date.now() - observed.catalogAt : Number.POSITIVE_INFINITY;
      if (observed && !observed.running && age < settledViewAge && (await stillCurrent(observed)))
        return observed.response;
      const reused = reusableTree(streams, age);
      changedHere = false;
      const transitions = streams.transitions;
      const snapshot =
        reused ?? (await readTree(request, identity, await currentMembers(), signal));
      if (!reused && contextId) streams.follow(snapshot.graph.all());
      // Live streams are fresher than the catalog while their tasks run.
      const graph = new TaskGraph(
        snapshot.graph.all().map((entry) => {
          const task = streams.task(entry.id);
          return task ? ingest(task, entry.agentId, entry.execution) : entry;
        }),
        snapshot.graph.sessions(),
        snapshot.graph.agents(),
      );
      const fullTask: FullTask = async (entry) =>
        streams.task(entry.id) ?? snapshot.tasks.get(entry.id) ?? projection.fullTask(entry);
      const view = await conversation(graph, request.agent, contextId, fullTask);
      await apps.project(view, graph, fullTask);
      view.operate = await operable();
      if (view.interactions.length)
        await approvalsFor(view.interactions, graph, identity.subject, view.operate);
      if (!view.ready) members = undefined;
      const quiet = view.ready && graph.all().every((entry) => settled(entry.state));
      const response = create(WatchConversationResponseSchema, {
        conversation: conversationTranscript(view),
      });
      observed = {
        catalogAt: reused && observed ? observed.catalogAt : Date.now(),
        transitions,
        response,
        revision: snapshot.revision,
        operate: view.operate,
        running: quiet ? undefined : snapshot,
      };
      return response;
    }

    try {
      yield* watchLive(projection, clients, WatchConversationResponseSchema, signal, build);
    } finally {
      release();
    }
  };
}
