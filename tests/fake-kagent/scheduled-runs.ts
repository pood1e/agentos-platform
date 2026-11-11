import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
  ScheduledRunExecutionSchema,
  ScheduledRunExecutionState,
  ScheduledRunSchema,
  ScheduledRunService,
} from "../../gen/kagent/api/v1/scheduled_runs_pb.js";
import type { FakeKagent } from "./kagent.js";
import { page } from "./resource-routes.js";

/** Creator-owned native schedules of the fake operator; firings are recorded, not executed. */
export function scheduledRunRoutes(
  { scheduledRuns: runs, scheduledExecutions: executions }: FakeKagent,
  router: ConnectRouter,
) {
  const stored = (id: string) => {
    const run = runs.get(id);
    if (!run || run.deletedAt) throw new ConnectError("Schedule not found", Code.NotFound);
    return run;
  };
  const valid = (schedule = "") => {
    if (schedule.trim().split(/\s+/).length !== 5)
      throw new ConnectError("Invalid schedule", Code.InvalidArgument);
  };
  router.service(ScheduledRunService, {
    createScheduledRun({ agent, config }) {
      valid(config?.schedule);
      const run = create(ScheduledRunSchema, {
        id: randomUUID(),
        creator: "user:operator",
        agent,
        config,
        etag: randomUUID(),
        createdAt: timestampNow(),
      });
      runs.set(run.id, run);
      return { scheduledRun: run };
    },
    getScheduledRun: ({ scheduledRunId }) => ({ scheduledRun: stored(scheduledRunId) }),
    listScheduledRuns({ page: request }) {
      const { items, token } = page(
        [...runs.values()].filter((run) => !run.deletedAt),
        request?.pageToken ?? "",
        request?.limit || 100,
      );
      return { scheduledRuns: items, page: { nextPageToken: token } };
    },
    updateScheduledRun({ scheduledRunId, etag, config }) {
      const run = stored(scheduledRunId);
      if (run.etag !== etag) throw new ConnectError("Schedule changed", Code.Aborted);
      valid(config?.schedule);
      Object.assign(run, { config, etag: randomUUID(), updatedAt: timestampNow() });
      return { scheduledRun: run };
    },
    deleteScheduledRun({ scheduledRunId }) {
      const run = stored(scheduledRunId);
      run.deletedAt = timestampNow();
      return { scheduledRun: run };
    },
    triggerScheduledRun({ scheduledRunId, requestId }) {
      const run = stored(scheduledRunId);
      const execution = create(ScheduledRunExecutionSchema, {
        id: randomUUID(),
        creator: run.creator,
        scheduledRunId,
        trigger: { case: "manualRequestId", value: requestId },
        prompt: run.config?.prompt,
        createdAt: timestampNow(),
        state: ScheduledRunExecutionState.PENDING,
      });
      executions.set(scheduledRunId, [execution, ...(executions.get(scheduledRunId) ?? [])]);
      return { execution };
    },
    listScheduledRunExecutions: ({ scheduledRunId }) => ({
      executions: executions.get(stored(scheduledRunId).id) ?? [],
    }),
  });
}
