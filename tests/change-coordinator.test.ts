import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import {
  ChangeControlService,
  type ChangeRequest,
  ChangeState,
  Governance,
  OperationsConfigSchema,
  PrepareChangeResponseSchema,
} from "../gen/agentos/governance/v1/change_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1alpha1/sessions_pb.js";
import * as connection from "../server/operations/client.js";
import { operationsCoordinator } from "../server/operations/coordinator.js";
import { hitlExtension, hitlPayload } from "../server/read-model/decode/hitl.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { operationHash } from "../server/shared/change-digest.js";
import { environment, fixtureCatalog, silent } from "./harness.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture(prepared: boolean, simulation = true) {
  vi.useFakeTimers();
  const { fake, sync } = environment([]);
  const name = "lab-real-jumpserver_ops_jobs_create",
    args = { name: "Collect device facts", run_after_save: true, timeout: 60 };
  const preparation = create(PrepareChangeResponseSchema, {
    operationHash: operationHash(name, args),
    plan: {
      impact: "Bounded read-only device collection",
      validation: "Read the native job output",
      rollback: "Stop on timeout; leave existing configuration intact",
      simulation: simulation ? { tenant: "agentos/simulation", id: "simulation-task" } : undefined,
    },
    simulationReport: simulation
      ? "The simulation inventory workflow was observed; GPU performance was not tested."
      : "",
  });
  const event = (kind: string, value: JsonValue) => ({
    metadata: { [partTypeKey]: kind },
    content: { case: "data" as const, value: fromJson(ValueSchema, value) },
  });
  const pause = create(MessageSchema, {
    messageId: "pause",
    role: Role.AGENT,
    extensions: [hitlExtension],
    metadata: {
      [hitlExtension]: {
        type: "tool_approval_request",
        tools: [{ id: "approval", call_id: "write", name, args }],
      },
    },
    parts: [{ content: { case: "text", value: "Collect device facts in one bounded job" } }],
  });
  const task = create(TaskSchema, {
    id: "operation",
    contextId: "operation-session",
    status: { state: TaskState.INPUT_REQUIRED, message: pause },
    history: [
      create(MessageSchema, {
        messageId: "user",
        role: Role.USER,
        parts: [{ content: { case: "text", value: "Verify the change approval path" } }],
      }),
      pause,
    ],
    artifacts: [
      {
        parts: [
          ...(prepared
            ? [
                event("function_call", { id: "preparation", name: "prepare_change", args: {} }),
                event("function_response", {
                  id: "preparation",
                  name: "prepare_change",
                  response: { output: toJson(PrepareChangeResponseSchema, preparation) },
                }),
              ]
            : []),
          event("function_call", { id: "write", name, args }),
        ],
      },
    ],
  });
  fake.sessions.set(
    task.contextId,
    create(SessionSchema, {
      id: task.contextId,
      agent: { namespace: "agentos", name: "remediation" },
    }),
  );
  fake.tasks.set(task.id, task);
  fake.update(task, TaskState.INPUT_REQUIRED, pause);
  await sync.refresh();
  let request: ChangeRequest | undefined,
    state = ChangeState.PENDING,
    preparedCount = 0;
  const result = () => ({
    result: {
      change: {
        id: "change",
        state,
        request,
        reason: "",
        decidedBy: state === ChangeState.APPROVED ? "ops" : "",
      },
    },
  });
  const register = vi.fn((incoming: ChangeRequest | undefined) => {
    request = incoming;
    return result();
  });
  const rpc = createClient(
    ChangeControlService,
    createRouterTransport((router) =>
      router.service(ChangeControlService, {
        getChange: () => {
          if (!request) throw new ConnectError("Not registered", Code.NotFound);
          return result();
        },
        registerChange: (incoming) => register(incoming.request),
        prepareExecution: () => {
          preparedCount++;
          return result();
        },
        recordResult: () => result(),
      }),
    ),
  );
  vi.spyOn(connection, "changeClient").mockReturnValue(rpc);
  const stop = operationsCoordinator(
    sync,
    create(OperationsConfigSchema, {
      environments: [{ environment: { name: "lab-real", governance: Governance.APPROVAL } }],
    }),
    silent,
    fixtureCatalog(),
  );
  return {
    fake,
    register,
    approve: () => {
      state = ChangeState.APPROVED;
    },
    decide: (value: ChangeState) => {
      state = value;
    },
    preparedCount: () => preparedCount,
    close: () => {
      stop();
      sync.close();
    },
  };
}

it("returns an unprepared write to the engineer without creating an empty work order", async () => {
  const env = await fixture(false);
  try {
    await vi.advanceTimersByTimeAsync(2001);
    expect(env.register).not.toHaveBeenCalled();
    const decision = hitlPayload(env.fake.received[0]);
    expect(decision?.type).toBe("tool_approval_response");
    if (decision?.type === "tool_approval_response")
      expect(decision.value.approvals[0]).toMatchObject({
        approved: false,
        rejectionReason: expect.stringContaining("prepare_change"),
      });
  } finally {
    env.close();
  }
});

it.each([
  [ChangeState.REJECTED, "approver rejected"],
  [ChangeState.CANCELED, "work order was closed"],
])(
  "reports the actual work-order decision %s without an expiration message",
  async (state, reason) => {
    const env = await fixture(true, false);
    try {
      await vi.advanceTimersByTimeAsync(2001);
      env.decide(state);
      await vi.advanceTimersByTimeAsync(2000);
      const decision = hitlPayload(env.fake.received[0]);
      expect(decision?.type).toBe("tool_approval_response");
      if (decision?.type === "tool_approval_response")
        expect(decision.value.approvals[0]).toMatchObject({
          approved: false,
          rejectionReason: expect.stringContaining(reason),
        });
    } finally {
      env.close();
    }
  },
);

it.each([true, false])(
  "automatically resumes the approved native tool with simulation %s",
  async (simulation) => {
    const env = await fixture(true, simulation);
    try {
      await vi.advanceTimersByTimeAsync(2001);
      expect(env.register).toHaveBeenCalledTimes(1);
      expect(env.register.mock.calls[0]?.[0]?.preparation?.plan?.impact).toBe(
        "Bounded read-only device collection",
      );
      expect(env.fake.received).toHaveLength(0);
      env.approve();
      await vi.advanceTimersByTimeAsync(2000);
      expect(env.preparedCount()).toBe(1);
      expect(env.fake.received).toHaveLength(1);
      const decision = hitlPayload(env.fake.received[0]);
      expect(decision?.type).toBe("tool_approval_response");
      if (decision?.type === "tool_approval_response")
        expect(decision.value.approvals).toMatchObject([{ id: "approval", approved: true }]);
    } finally {
      env.close();
    }
  },
);
