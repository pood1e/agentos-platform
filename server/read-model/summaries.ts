import { toBinary } from "@bufbuild/protobuf";
import { TaskSummarySchema } from "../../gen/agentos/console/v1/task_pb.js";
import type { TaskGraph } from "./graph.js";
import type { ReadWriter } from "./store.js";
import { taskTree } from "./tree.js";
import { conversationProgress } from "./views/conversation-work.js";
import { taskSummary } from "./views/task.js";

const search = (...values: string[]) => values.join(" ").toLowerCase();

/** List rows of one execution tree, materialized at write time so listing pages in SQL. */
export function summarize(graph: TaskGraph) {
  const conversations = graph.sessions().map((session) => {
    const progress = conversationProgress(graph, session.id);
    return {
      context_id: session.id,
      agent_id: session.agentId,
      title: session.name,
      search: search(
        session.name,
        ...graph.contextEntries(session.id).map((entry) => entry.prompt),
      ),
      state: progress.state,
      updated_at: Math.max(session.updatedAt ?? 0, progress.updatedAt),
    };
  });
  const operations = graph.relations().roots.flatMap((root) => {
    const tree = taskTree(graph, root.id);
    if (!tree) return [];
    const summary = taskSummary(graph, tree);
    return [
      {
        task_id: root.id,
        state: summary.state,
        members: [...new Set(tree.entries.map((entry) => entry.agentId))],
        search: search(summary.prompt, root.id),
        updated_at: tree.updatedAt ?? 0,
        summary: Buffer.from(toBinary(TaskSummarySchema, summary)),
      },
    ];
  });
  return { conversations, operations };
}

/** Replaces the summaries of one tree; the caller holds the tree's advisory lock. */
export async function storeSummaries(
  { tx }: ReadWriter,
  workspace: string,
  root: string,
  subject: string,
  rows: ReturnType<typeof summarize>,
) {
  const owned = <T extends object>(values: T[]) =>
    values.map((value) => ({ workspace, root_session_id: root, subject, ...value }));
  await tx`delete from agentos_read.conversations
    where workspace = ${workspace} and root_session_id = ${root}
      and not (context_id = any(${rows.conversations.map((row) => row.context_id)}))`;
  await tx`delete from agentos_read.operations
    where workspace = ${workspace} and root_session_id = ${root}
      and not (task_id = any(${rows.operations.map((row) => row.task_id)}))`;
  if (rows.conversations.length)
    await tx`insert into agentos_read.conversations ${tx(owned(rows.conversations))}
      on conflict (workspace, context_id) do update set root_session_id = excluded.root_session_id,
        agent_id = excluded.agent_id, subject = excluded.subject, title = excluded.title,
        search = excluded.search, state = excluded.state, updated_at = excluded.updated_at`;
  if (rows.operations.length)
    await tx`insert into agentos_read.operations ${tx(owned(rows.operations))}
      on conflict (workspace, task_id) do update set root_session_id = excluded.root_session_id,
        subject = excluded.subject, state = excluded.state, members = excluded.members,
        search = excluded.search, updated_at = excluded.updated_at, summary = excluded.summary`;
}
