import { createServer } from "node:http";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { expect, it as test } from "vitest";
import { MessageSchema, Role, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/execution/v1/state_pb.js";
import {
  ApprovalSchema,
  ApprovalService,
  GovernanceConfigSchema,
} from "../gen/agentos/governance/v1/governance_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1/sessions_pb.js";
import { approvalCoordinator } from "../server/governance/coordinator.js";
import { hitlExtension, hitlPayload } from "../server/read-model/decode/hitl.js";
import { ingest } from "../server/read-model/entry.js";
import { startJobs } from "./fixtures/coordination.js";
import { environment, silent, until } from "./harness.js";

const it = test.skipIf(!process.env.CHANGE_TEST_DATABASE_URL);

async function setup(
  provider: Partial<ServiceImpl<typeof ApprovalService>>,
  authorize?: Parameters<typeof approvalCoordinator>[2],
) {
  const server = createServer(
    connectNodeAdapter({ routes: (router) => router.service(ApprovalService, provider) }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider is unavailable");
  const message = create(MessageSchema, {
    messageId: "confirmation",
    role: Role.AGENT,
    extensions: [hitlExtension],
    metadata: {
      [hitlExtension]: {
        type: "tool_approval_request",
        tools: [
          {
            id: "publish",
            call_id: "publish-call",
            name: "publishing-cms_publish",
            args: { document: "release" },
          },
        ],
      },
    },
  });
  const task = create(TaskSchema, {
    id: "publish-task",
    contextId: "publish-session",
    status: { state: TaskState.INPUT_REQUIRED, message },
    history: [message],
  });
  const env = environment([task]);
  env.fake.load({
    sessions: [
      create(SessionSchema, {
        id: task.contextId,
        agent: { namespace: "agentos", name: "inspection" },
      }),
    ],
    tasks: [task],
  });
  await env.sync.refresh();
  const config = create(GovernanceConfigSchema, {
    environments: [
      { environment: { name: "publishing" }, approvalUrl: `http://127.0.0.1:${address.port}` },
    ],
  });
  const stop = await startJobs(env.sync, silent, [
    approvalCoordinator(env.sync, config, authorize),
  ]);
  return {
    ...env,
    task,
    close: async () => {
      await stop();
      env.sync.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("reuses an external review and prepares execution before answering the native pause", async () => {
  let reviews = 0,
    reads = 0,
    preparations = 0,
    exists = false;
  const env = await setup({
    getApproval: () => {
      reads++;
      if (!exists) throw new ConnectError("Missing", Code.NotFound);
      return { approval: create(ApprovalSchema, { id: "review", state: ActivityState.SUCCEEDED }) };
    },
    reviewApproval: ({ context }) => {
      reviews++;
      exists = true;
      expect(context?.tool?.name).toBe("publishing-cms_publish");
      return {
        approval: create(ApprovalSchema, { id: "review", state: ActivityState.AWAITING_APPROVAL }),
      };
    },
    prepareApproval: () => {
      preparations++;
      return { approval: create(ApprovalSchema, { id: "review", state: ActivityState.WORKING }) };
    },
  });
  try {
    await until(() => env.fake.received.length === 1, 5_000);
    expect(reviews).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(preparations).toBe(1);
    expect(hitlPayload(env.fake.received[0])).toMatchObject({
      type: "tool_approval_response",
      value: { approvals: [{ id: "publish", approved: true }] },
    });
  } finally {
    await env.close();
  }
});

it("keeps native execution paused when the decision service is unavailable", async () => {
  let reads = 0;
  const env = await setup({
    getApproval: () => {
      reads++;
      throw new ConnectError("Offline", Code.Unavailable);
    },
  });
  try {
    await until(() => reads > 0);
    expect(env.fake.received).toHaveLength(0);
  } finally {
    await env.close();
  }
});

it("returns failed policy validation to the Agent without preparing execution or recording a human rejection", async () => {
  let preparations = 0;
  const env = await setup({
    getApproval: () => ({
      approval: create(ApprovalSchema, {
        id: "validation",
        state: ActivityState.FAILED,
        reason: "Required evidence is missing",
      }),
    }),
    prepareApproval: () => {
      preparations++;
      return {};
    },
  });
  try {
    await until(() => env.fake.received.length === 1, 5_000);
    expect(preparations).toBe(0);
    const reply = env.fake.received[0];
    expect(hitlPayload(reply)).toMatchObject({
      type: "tool_approval_response",
      value: { approvals: [{ approved: false, rejectionReason: "Required evidence is missing" }] },
    });
    const record = create(TaskSchema, env.task);
    record.history.push(reply);
    expect(ingest(record, "agentos/inspection").interactions[0]?.state).toBe(ActivityState.FAILED);
  } finally {
    await env.close();
  }
});

it("does not resume a task canceled while its external authorization is being prepared", async () => {
  let preparing = false;
  let release: () => void = () => {};
  const prepared = new Promise<void>((resolve) => {
    release = resolve;
  });
  const env = await setup({
    getApproval: () => ({
      approval: create(ApprovalSchema, { id: "review", state: ActivityState.SUCCEEDED }),
    }),
    prepareApproval: async () => {
      preparing = true;
      await prepared;
      return { approval: create(ApprovalSchema, { id: "review", state: ActivityState.WORKING }) };
    },
  });
  try {
    await until(() => preparing);
    if (env.task.status) env.task.status.state = TaskState.CANCELED;
    env.index.upsert(ingest(env.task, "agentos/inspection"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(env.fake.received).toHaveLength(0);
  } finally {
    release();
    await env.close();
  }
});

it("rejects an unauthorized write before contacting the external approval service", async () => {
  let external = 0;
  const env = await setup(
    {
      getApproval: () => {
        external++;
        return {};
      },
      reviewApproval: () => {
        external++;
        return {};
      },
    },
    async () => {
      throw new ConnectError("Read-only execution", Code.PermissionDenied);
    },
  );
  try {
    await until(() => env.fake.received.length > 0);
    expect(external).toBe(0);
    expect(hitlPayload(env.fake.received[0])).toMatchObject({
      type: "tool_approval_response",
      value: { approvals: [{ approved: false, rejectionReason: "Read-only execution" }] },
    });
  } finally {
    await env.close();
  }
});

it("keeps approval pending while execution metadata is unavailable and retries authorization", async () => {
  let checks = 0,
    reads = 0;
  const env = await setup(
    {
      getApproval: () => {
        reads++;
        return {
          approval: create(ApprovalSchema, { id: "review", state: ActivityState.SUCCEEDED }),
        };
      },
      prepareApproval: () => ({
        approval: create(ApprovalSchema, { id: "review", state: ActivityState.WORKING }),
      }),
    },
    async () => {
      if (++checks === 1) throw new ConnectError("MCP tool metadata unavailable", Code.Unavailable);
    },
  );
  try {
    await until(() => checks === 1);
    expect(reads).toBe(0);
    expect(env.fake.received).toHaveLength(0);
    await until(() => env.fake.received.length === 1, 8_000);
    expect(hitlPayload(env.fake.received[0])).toMatchObject({
      value: { approvals: [{ approved: true }] },
    });
  } finally {
    await env.close();
  }
});

it("rechecks execution permissions after an external approval and before preparation", async () => {
  let checks = 0,
    preparations = 0;
  const env = await setup(
    {
      getApproval: () => ({
        approval: create(ApprovalSchema, { id: "review", state: ActivityState.SUCCEEDED }),
      }),
      prepareApproval: () => {
        preparations++;
        return {};
      },
    },
    async () => {
      if (++checks > 1) throw new ConnectError("Revoked", Code.PermissionDenied);
    },
  );
  try {
    await until(() => env.fake.received.length > 0);
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(preparations).toBe(0);
    expect(hitlPayload(env.fake.received[0])).toMatchObject({
      value: { approvals: [{ approved: false }] },
    });
  } finally {
    await env.close();
  }
});

it("recovers a preparation whose external commit succeeded before its response was lost", async () => {
  let committed = false,
    commits = 0,
    attempts = 0;
  const env = await setup({
    getApproval: () => ({
      approval: create(ApprovalSchema, { id: "review", state: ActivityState.SUCCEEDED }),
    }),
    prepareApproval: () => {
      attempts++;
      if (!committed) {
        committed = true;
        commits++;
        throw new ConnectError("Response lost after commit", Code.Unavailable);
      }
      return { approval: create(ApprovalSchema, { id: "review", state: ActivityState.SUCCEEDED }) };
    },
    recordApprovalResult: () => ({}),
  });
  try {
    await until(() => env.fake.received.length === 1, 8_000);
    expect(commits).toBe(1);
    expect(attempts).toBe(2);
    expect(hitlPayload(env.fake.received[0])).toMatchObject({
      value: { approvals: [{ approved: true }] },
    });
  } finally {
    await env.close();
  }
});
