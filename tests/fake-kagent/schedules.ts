import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { clone, create, fromJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { MessageSchema, Role, TaskState } from "../../gen/a2a_pb.js";
import { AutomationPresetsSchema } from "../../gen/agentos/automation/v1/service_pb.js";
import {
  type CreateScheduledRunRequest,
  type ScheduledRun,
  type ScheduledRunExecution,
  ScheduledRunExecutionSchema,
  ScheduledRunExecutionState,
  ScheduledRunSchema,
  type ScheduledRunService,
} from "../../gen/kagent/api/v1/scheduled_runs_pb.js";
import type { FakeKagent } from "./kagent.js";

const missing = () => new ConnectError("Schedule not found", Code.NotFound);
const page = <T>(items: T[], token = "", size = 50) => ({
  items: items.slice(Number(token), Number(token) + size),
  page: { nextPageToken: Number(token) + size < items.length ? String(Number(token) + size) : "" },
});

export class FakeSchedules {
  readonly schedules = new Map<string, ScheduledRun>();
  readonly executions = new Map<string, ScheduledRunExecution>();
  private requests = new Map<string, { hash: string; id: string }>();
  private firings = new Map<string, string>();
  private presetIds = new Map<string, string>();

  constructor(private fake: FakeKagent) {
    this.reset();
  }

  reset() {
    this.schedules.clear();
    this.executions.clear();
    this.requests.clear();
    this.firings.clear();
    const presets = fromJsonString(
      AutomationPresetsSchema,
      readFileSync("tests/fixtures/pack/automation.json", "utf8"),
    );
    for (const request of presets.scheduledRuns) {
      if (request.agent) request.agent.namespace = "agentos";
      request.requestId = `preset/agentos/${request.requestId}`;
      this.create(request);
    }
  }

  private get(id: string) {
    const schedule = this.schedules.get(id);
    if (!schedule) throw missing();
    return schedule;
  }

  private create(request: CreateScheduledRunRequest) {
    const hash = JSON.stringify({ agent: request.agent, config: request.config }, (_, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
    const previous = this.requests.get(request.requestId);
    if (previous) {
      if (previous.hash !== hash)
        throw new ConnectError("Different preset input", Code.AlreadyExists);
      return this.get(previous.id);
    }
    if (request.config?.schedule.trim().split(/\s+/).length !== 5)
      throw new ConnectError("Invalid cron", Code.InvalidArgument);
    try {
      new Intl.DateTimeFormat("en", { timeZone: request.config.timeZone || "UTC" });
    } catch {
      throw new ConnectError("Invalid time zone", Code.InvalidArgument);
    }
    const preset = request.requestId.startsWith("preset/");
    const id = (preset && this.presetIds.get(request.requestId)) || randomUUID();
    if (preset) this.presetIds.set(request.requestId, id);
    const schedule = create(ScheduledRunSchema, {
      id,
      etag: randomUUID(),
      creator: "agentos",
      agent: request.agent,
      config: request.config,
      createdAt: timestampFromMs(Date.now()),
      updatedAt: timestampFromMs(Date.now()),
      nextExecutionTime: request.config.paused ? undefined : timestampFromMs(Date.now() + 60_000),
    });
    this.schedules.set(schedule.id, schedule);
    this.requests.set(request.requestId, { hash, id: schedule.id });
    return schedule;
  }

  private execution(id: string) {
    const execution = this.executions.get(id);
    if (!execution) throw missing();
    const task = this.fake.tasks.get(execution.taskId);
    if (task?.status?.state === TaskState.COMPLETED)
      execution.state = ScheduledRunExecutionState.SUCCEEDED;
    else if (task?.status?.state === TaskState.FAILED)
      execution.state = ScheduledRunExecutionState.FAILED;
    return execution;
  }

  private start(execution: ScheduledRunExecution) {
    const schedule = this.get(execution.scheduledRunId);
    const session = this.fake.createSession(
      { namespace: schedule.agent?.namespace ?? "", name: schedule.agent?.name ?? "" },
      `scheduled-run/${execution.id}`,
      schedule.config?.name ?? "",
    );
    execution.state = ScheduledRunExecutionState.RUNNING;
    execution.sessionId = session.id;
    execution.taskId = this.fake.accept(
      createMessage(session.id, execution.id, execution.prompt),
    ).id;
  }

  service(): ServiceImpl<typeof ScheduledRunService> {
    return {
      createScheduledRun: (r) => ({ scheduledRun: this.create(r) }),
      getScheduledRun: (r) => ({ scheduledRun: this.get(r.scheduledRunId) }),
      listScheduledRuns: (r) => {
        const result = page(
          [...this.schedules.values()].filter((item) => !item.deletedAt).reverse(),
          r.page?.pageToken,
          r.page?.limit || 50,
        );
        return { scheduledRuns: result.items, page: result.page };
      },
      updateScheduledRun: (r) => {
        const previous = this.get(r.scheduledRunId);
        if (previous.etag !== r.etag) throw new ConnectError("Stale configuration", Code.Aborted);
        if (previous.deletedAt) throw missing();
        const schedule = clone(ScheduledRunSchema, previous);
        schedule.config = r.config;
        schedule.etag = randomUUID();
        schedule.updatedAt = timestampFromMs(Date.now());
        schedule.nextExecutionTime = r.config?.paused
          ? undefined
          : timestampFromMs(Date.now() + 60_000);
        this.schedules.set(schedule.id, schedule);
        return { scheduledRun: schedule };
      },
      deleteScheduledRun: (r) => {
        const schedule = this.get(r.scheduledRunId);
        schedule.deletedAt ??= timestampFromMs(Date.now());
        schedule.nextExecutionTime = undefined;
        return { scheduledRun: schedule };
      },
      triggerScheduledRun: (r) => {
        const schedule = this.get(r.scheduledRunId);
        if (schedule.deletedAt) throw missing();
        const key = `${schedule.id}/${r.requestId}`;
        const previous = this.firings.get(key);
        if (previous) return { execution: this.execution(previous) };
        const execution = create(ScheduledRunExecutionSchema, {
          id: randomUUID(),
          scheduledRunId: schedule.id,
          creator: schedule.creator,
          prompt: schedule.config?.prompt,
          state: ScheduledRunExecutionState.PENDING,
          awaitingDispatch: schedule.config?.dispatchRequired,
          trigger: { case: "manualRequestId", value: r.requestId },
          createdAt: timestampFromMs(Date.now()),
          deadline: timestampFromMs(Date.now() + 900_000),
        });
        if (!execution.awaitingDispatch) this.start(execution);
        this.executions.set(execution.id, execution);
        this.firings.set(key, execution.id);
        return { execution };
      },
      dispatchScheduledRunExecution: (r) => {
        const execution = this.execution(r.executionId);
        if (!execution.awaitingDispatch) {
          if (
            execution.dispatchReason === r.reason &&
            (execution.state === ScheduledRunExecutionState.SKIPPED) === r.skip
          )
            return { execution };
          throw new ConnectError("Execution already dispatched", Code.Aborted);
        }
        execution.awaitingDispatch = false;
        execution.dispatchReason = r.reason;
        if (r.skip) {
          execution.state = ScheduledRunExecutionState.SKIPPED;
          execution.completedAt = timestampFromMs(Date.now());
        } else this.start(execution);
        return { execution };
      },
      getScheduledRunExecution: (r) => ({ execution: this.execution(r.executionId) }),
      listScheduledRunExecutions: (r) => {
        const result = page(
          [...this.executions.values()]
            .filter(
              (item) =>
                item.scheduledRunId === r.scheduledRunId &&
                (!r.activeOnly ||
                  [ScheduledRunExecutionState.PENDING, ScheduledRunExecutionState.RUNNING].includes(
                    item.state,
                  )),
            )
            .reverse(),
          r.page?.pageToken,
          r.page?.limit || 50,
        );
        return {
          executions: result.items.map((item) => this.execution(item.id)),
          page: result.page,
        };
      },
    };
  }
}

function createMessage(contextId: string, executionId: string, prompt: string) {
  return create(MessageSchema, {
    messageId: `scheduled-run/${executionId}`,
    contextId,
    taskId: "",
    role: Role.USER,
    parts: [{ content: { case: "text", value: prompt } }],
  });
}
