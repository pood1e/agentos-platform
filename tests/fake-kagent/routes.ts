import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs, timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { A2AService, TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import { ExecutionService } from "../../gen/kagent/api/v1/execution_pb.js";
import { RuntimeState } from "../../gen/kagent/api/v1/runtime_pb.js";
import { SessionService } from "../../gen/kagent/api/v1/sessions_pb.js";
import { SystemService } from "../../gen/kagent/api/v1/system_pb.js";
import { agentKey } from "../../server/kagent/resources.js";
import { millis } from "../../server/read-model/decode/messages.js";
import { terminal } from "../../server/read-model/state.js";
import type { FakeKagent } from "./kagent.js";
import { page, resourceRoutes } from "./resource-routes.js";
import { taskCatalogRoutes } from "./task-catalog.js";
import { workflowRoutes } from "./workflows.js";

/** Official kagent and A2A services backed by the fake runtime. */
export const kagentRoutes = (fake: FakeKagent) => (router: ConnectRouter) => {
  workflowRoutes(fake, router);
  taskCatalogRoutes(fake, router);
  resourceRoutes(fake, router);
  router.service(SystemService, {
    getCurrentUser: () => ({ principalId: "user:operator", claims: { roles: [] } }),
  });
  router.service(ExecutionService, {
    getTaskExecution: (request) => ({ execution: fake.executions.get(request.taskId) }),
    getSessionAuthority: (request) => ({
      authority: fake.sessions.get(request.sessionId)?.authority,
      revoked: !fake.renewable,
    }),
    getDelegationCredentialStatus: () => ({ renewable: fake.renewable }),
    issueSessionCredential(request) {
      const credential = `kagent-session.${randomUUID()}`;
      fake.credentials.set(credential, request.sessionId);
      return {
        credential,
        expiresAt: timestampFromMs(Date.now() + Number(request.ttl?.seconds ?? 600n) * 1000),
      };
    },
  });
  router.service(SessionService, {
    listSessions(request) {
      const { items, token } = page(
        [...fake.sessions.values()].filter(
          (s) =>
            (!request.rootSessionId || s.authority?.rootSessionId === request.rootSessionId) &&
            (!request.agent || agentKey(s.agent?.ref) === agentKey(request.agent)),
        ),
        request.page?.pageToken ?? "",
        request.page?.limit || 100,
      );
      return { sessions: items, page: { nextPageToken: token } };
    },
    getSession(request, context) {
      const credential = context.requestHeader.get("authorization")?.slice(7) ?? "";
      if (
        credential.startsWith("kagent-session.") &&
        (!fake.renewable || fake.credentials.get(credential) !== request.sessionId)
      )
        throw new ConnectError("Session credential denied", Code.PermissionDenied);
      const session = fake.sessions.get(request.sessionId);
      if (!session || session.state === RuntimeState.DELETED)
        throw new ConnectError("session not found", Code.NotFound);
      return { session };
    },
    deleteSession(request) {
      const session = fake.sessions.get(request.sessionId);
      if (!session || session.state === RuntimeState.DELETED)
        throw new ConnectError("session not found", Code.NotFound);
      fake.sessions.delete(session.id);
      for (const task of fake.tasks.values())
        if (task.contextId === session.id) fake.tasks.delete(task.id);
      return { session };
    },
    createSession: (request) => ({
      session: fake.createSession(
        { namespace: request.agent?.namespace ?? "", name: request.agent?.name ?? "" },
        request.requestId,
        request.name,
      ),
    }),
  });
  router.service(A2AService, {
    listTasks(request) {
      const after = request.statusTimestampAfter
        ? timestampMs(request.statusTimestampAfter)
        : undefined;
      const tasks = [...fake.tasks.values()].filter(
        (task) =>
          fake.tenantOf(task) === request.tenant &&
          (!request.contextId || task.contextId === request.contextId) &&
          (after === undefined || (millis(task.status?.timestamp) ?? 0) > after),
      );
      const { items, token } = page(tasks, request.pageToken, request.pageSize ?? 50);
      fake.listed.push({
        tenant: request.tenant,
        incremental: after !== undefined,
        returned: items.length,
      });
      return {
        tasks: items.map((task) =>
          create(TaskSchema, {
            ...task,
            history:
              request.historyLength === undefined
                ? task.history
                : request.historyLength === 0
                  ? []
                  : task.history.slice(-request.historyLength),
            artifacts: request.includeArtifacts ? task.artifacts : [],
          }),
        ),
        nextPageToken: token,
        pageSize: items.length,
        totalSize: tasks.length,
      };
    },
    getTask(request) {
      fake.fetched.push(request.id);
      return fake.task(request.id);
    },
    cancelTask(request) {
      const task = fake.task(request.id);
      if (fake.tenantOf(task) !== request.tenant)
        throw new ConnectError("task not found", Code.NotFound);
      if (!terminal(task.status?.state)) fake.update(task, TaskState.CANCELED);
      return task;
    },
    subscribeToTask: (request, context) => fake.follow(request.id, context.signal),
    async *sendStreamingMessage(request, context) {
      if (!request.message) throw new ConnectError("message required", Code.InvalidArgument);
      yield* fake.follow(fake.accept(request.message).id, context.signal);
    },
    sendMessage(request) {
      if (!request.message) throw new ConnectError("message required", Code.InvalidArgument);
      return { payload: { case: "task", value: fake.accept(request.message) } };
    },
  });
  return router;
};
