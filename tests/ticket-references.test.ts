import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InteractionKind,
  InteractionSchema,
  TaskDetailSchema,
} from "../gen/agentos/console/v1/task_pb.js";
import {
  ChangeSchema,
  ChangeState,
  Governance,
  OperationsConfigSchema,
} from "../gen/agentos/governance/v1/change_pb.js";
import { ticketReferences } from "../server/console/ticket-references.js";
import { changes } from "../server/operations/views.js";
import { environment } from "./harness.js";

vi.mock("../server/operations/views.js", () => ({ changes: vi.fn() }));
const read = vi.mocked(changes);
const task = () =>
  create(TaskDetailSchema, {
    interactions: [
      create(InteractionSchema, {
        id: "approval",
        taskId: "task",
        requestId: "request",
        kind: InteractionKind.APPROVAL,
      }),
    ],
  });
const change = () =>
  create(ChangeSchema, {
    id: "change",
    ticketId: "19",
    ticketUrl: "https://zammad.example/#ticket/zoom/19",
    environment: { name: "aiops-real", governance: Governance.APPROVAL },
    state: ChangeState.PENDING,
    request: {
      engineer: "asset",
      prompt: "private evidence",
      tool: { args: { password: "private-credential" } },
    },
  });
const resolver = () => ticketReferences(environment([]).sync, create(OperationsConfigSchema));
beforeEach(() => {
  read.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("console ticket references", () => {
  it("shares native lookups and excludes request credentials and evidence from the task stream", async () => {
    read.mockResolvedValue({ changes: [change()] });
    const enrich = resolver();
    const original = task();
    const [first, second] = await Promise.all([
      enrich(clone(TaskDetailSchema, original)),
      enrich(clone(TaskDetailSchema, original)),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first.interactions[0]?.changes[0]).toMatchObject({
      ticketId: "19",
      state: ChangeState.PENDING,
    });
    expect(first.interactions[0]?.changes[0]?.request).toBeUndefined();
    expect(second).toEqual(first);
    expect(toJsonString(TaskDetailSchema, first)).not.toMatch(
      /private-credential|private evidence/,
    );
    expect(original.interactions[0]?.changes).toEqual([]);
  });

  it("keeps the original collaboration available when an environment lookup fails", async () => {
    read.mockRejectedValue(new Error("environment unavailable"));
    const original = task();
    expect(await resolver()(clone(TaskDetailSchema, original))).toEqual(original);
  });

  it("preserves discovered ticket identity during a temporary environment outage", async () => {
    let clock = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    read
      .mockResolvedValueOnce({ changes: [change()] })
      .mockRejectedValue(new Error("temporary outage"));
    const enrich = resolver();
    const original = task();
    const first = await enrich(clone(TaskDetailSchema, original));
    clock += 6_000;
    await new Promise((resolve) => setTimeout(resolve, 2));
    const observed = await enrich(clone(TaskDetailSchema, original));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(observed).toEqual(first);
  });
});
