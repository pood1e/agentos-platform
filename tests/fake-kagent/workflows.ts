import { readFileSync } from "node:fs";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { WorkflowService } from "../../gen/kagent/api/v1/workflows_pb.js";
import type { FakeKagent } from "./kagent.js";

const schema = JSON.parse(
  readFileSync(
    new URL("../../third_party/kagent-crds/workflow.schema.json", import.meta.url),
    "utf8",
  ),
);

export function workflowRoutes(fake: FakeKagent, router: ConnectRouter) {
  router.service(WorkflowService, {
    getWorkflowSchema: () => ({ schema }),
    getWorkflowRevision: () => ({ preparedRevision: "workflow-test-revision" }),
    validateWorkflow: () => ({ preparedRevision: "workflow-test-revision" }),
    getSessionWorkflow: ({ sessionId }) => {
      if (!fake.sessions.has(sessionId)) throw new ConnectError("Session not found", Code.NotFound);
      const result = fake.workflowDefinitions.get(sessionId);
      if (!result) throw new ConnectError("Workflow definition not found", Code.NotFound);
      return result;
    },
  });
}
