import { Code } from "@connectrpc/connect";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import type { UpdateTaskTagsRequest } from "../../gen/agentos/console/v1/console_service_pb.js";
import type { Conversation } from "../../gen/agentos/console/v1/conversation_pb.js";
import type { ExecutionIdentity } from "../../gen/agentos/execution/v1/identity_pb.js";
import { can } from "../../shared/permissions.js";
import type { Executions } from "../authorization/executions.js";
import type { KagentClients } from "../kagent/clients.js";
import type { TaskEntry } from "../read-model/entry.js";
import type { TaskGraph } from "../read-model/graph.js";
import { taskTree } from "../read-model/tree.js";
import { taskSummary } from "../read-model/views/task.js";
import { fail, notFound } from "../shared/errors.js";
import { emptyTags, type TaskTagStore } from "../tasks/tags.js";

export function taskTagCommands(
  clients: KagentClients,
  store: TaskTagStore,
  executions: Executions,
) {
  async function editable(root: TaskEntry, identity: ExecutionIdentity) {
    try {
      const { session } = await clients.sessions.getSession(
        { sessionId: root.contextId },
        { timeoutMs: 5_000 },
      );
      if (!session) return false;
      const { binding } = await executions.record(session, true);
      return binding.subject.startsWith("service:")
        ? can(identity, Capability.TASKS_MANAGE)
        : binding.subject === identity.subject;
    } catch {
      return false;
    }
  }
  return {
    async conversation(view: Conversation) {
      const tasks = view.messages.flatMap((message) => message.tasks);
      if (!tasks.length) return;
      const metadata = await store.read(tasks.map((task) => task.id));
      for (const task of tasks) Object.assign(task, metadata.get(task.id) ?? emptyTags());
    },
    async update(
      request: UpdateTaskTagsRequest,
      view: TaskGraph | undefined,
      identity: ExecutionIdentity,
    ) {
      const root = view?.operationRoot(request.taskId);
      const tree = view && root && taskTree(view, root.id);
      if (!tree) throw notFound("task.notFound");
      if (!(await editable(tree.root, identity)))
        throw fail(Code.PermissionDenied, "task.tagsDenied");
      const tags = await store.save(tree.root.id, request.tags, request.tagsVersion);
      return { task: Object.assign(taskSummary(view, tree), tags) };
    },
  };
}
