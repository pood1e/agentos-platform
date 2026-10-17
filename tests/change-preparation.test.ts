import assert from "node:assert/strict";
import { clone, create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import { ArtifactSchema, GetTaskRequestSchema, TaskSchema, TaskState } from "../gen/a2a_pb.js";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { ToolCallSchema } from "../gen/agentos/console/v1/task_pb.js";
import {
  EnvironmentConnectionSchema,
  Governance,
  PrepareChangeRequestSchema,
  PrepareChangeResponseSchema,
} from "../gen/agentos/governance/v1/change_pb.js";
import { AgentSchema } from "../gen/kagent/api/v1alpha1/agents_pb.js";
import { SessionSchema } from "../gen/kagent/api/v1alpha1/sessions_pb.js";
import { changePreparation, preparedChange } from "../server/operations/preparation.js";
import { partTypeKey } from "../server/read-model/decode/messages.js";
import { environment, fixtureCatalog } from "./harness.js";

function fixture() {
  const { clients, fake } = environment([]);
  fake.agents.push(
    create(AgentSchema, {
      ref: { namespace: "agentos", name: "simulation" },
      resource: {
        value: { metadata: { name: "simulation", labels: { "agentos.dev/role": "simulation" } } },
      },
    }),
  );
  fake.sessions.set(
    "sim-session",
    create(SessionSchema, {
      id: "sim-session",
      agent: { namespace: "agentos", name: "simulation" },
    }),
  );
  const event = (kind: string, payload: JsonValue) => ({
    metadata: { [partTypeKey]: kind },
    content: { case: "data" as const, value: fromJson(ValueSchema, payload) },
  });
  const task = create(TaskSchema, {
    id: "sim-task",
    contextId: "sim-session",
    status: { state: TaskState.COMPLETED },
    artifacts: [
      {
        parts: [
          event("function_call", {
            id: "read",
            name: "lab-sim-netbox_netbox_get_objects",
            args: { object_type: "dcim.sites" },
          }),
          event("function_response", {
            id: "read",
            name: "lab-sim-netbox_netbox_get_objects",
            response: { output: { results: [{ name: "lab-sim" }] } },
          }),
          {
            content: {
              case: "text",
              value:
                "Inventory API observations are available. No equivalent GPU or RDMA simulator is attached; NCCL performance remains unvalidated.",
            },
          },
        ],
      },
    ],
  });
  fake.tasks.set(task.id, task);
  const environments = [
    create(EnvironmentConnectionSchema, {
      environment: { name: "lab-real", governance: Governance.APPROVAL },
    }),
    create(EnvironmentConnectionSchema, {
      environment: { name: "lab-sim", governance: Governance.DIRECT },
    }),
  ];
  const prepare = changePreparation(clients, "agentos", environments, fixtureCatalog());
  const request = create(PrepareChangeRequestSchema, {
    toolName: "lab-real-jumpserver_ops_jobs_create",
    args: { name: "Collect device facts", run_after_save: true, timeout: 60 },
    plan: {
      impact: "Bounded read-only collection; no device configuration changes",
      validation: "Read the native job output for both devices",
      rollback: "Stop on timeout; no configuration rollback is needed",
      simulation: { tenant: "agentos/simulation", id: task.id },
    },
  });
  return { prepare, request, task, clients };
}

describe("change preparation with optional native simulation evidence", () => {
  it("directs asset registration to native authorization without preparing a work order", async () => {
    const { prepare, request } = fixture();
    await expect(
      prepare({ ...request, toolName: "lab-real-netbox_dcim_devices_create" }),
    ).rejects.toThrow("native permissions and audit");
    await expect(
      prepare({ ...request, toolName: "lab-real-jumpserver_assets_hosts_create" }),
    ).rejects.toThrow("native permissions and audit");
  });
  it("prepares a scoped plan without simulation or any simulation RPC", async () => {
    const { prepare, request, clients } = fixture();
    assert(request.plan);
    request.plan.simulation = undefined;
    request.plan.validation = "Read device facts after scoped approval; hardware is not simulated";
    const getTask = vi.spyOn(clients.a2a, "getTask");
    const getAgent = vi.spyOn(clients.agents, "getAgent");
    const response = await prepare(request);
    expect(response.plan).toEqual(request.plan);
    expect(response.simulationReport).toBe("");
    expect(response.operationHash).toHaveLength(64);
    expect(getTask).not.toHaveBeenCalled();
    expect(getAgent).not.toHaveBeenCalled();
  });

  it("reads the real simulation task and preserves its unvalidated capabilities", async () => {
    const { prepare, request } = fixture();
    const response = await prepare(request);
    expect(response.plan).toEqual(request.plan);
    expect(response.simulationReport).toContain("NCCL performance remains unvalidated");
    expect(response.simulationReport).toContain("lab-sim-netbox_netbox_get_objects");
    expect(response.operationHash).toHaveLength(64);
  });

  it("requires a completed simulation engineer task in the same workspace", async () => {
    const { prepare, request, task } = fixture();
    const changed = clone(PrepareChangeRequestSchema, request);
    assert(changed.plan);
    changed.plan.simulation = create(GetTaskRequestSchema, {
      tenant: "other/simulation",
      id: task.id,
    });
    await expect(prepare(changed)).rejects.toThrow("this workspace");
    changed.plan.simulation = create(GetTaskRequestSchema, {
      tenant: "agentos/inspection",
      id: task.id,
    });
    await expect(prepare(changed)).rejects.toThrow("different engineer context");
    if (task.status) task.status.state = TaskState.WORKING;
    await expect(prepare(request)).rejects.toThrow("finish");
  });

  it("rejects a finished task with no observed simulation environment evidence", async () => {
    const { prepare, request, task } = fixture();
    task.artifacts = [
      create(ArtifactSchema, { parts: [{ content: { case: "text", value: "Claimed success" } }] }),
    ];
    await expect(prepare(request)).rejects.toThrow("observed environment evidence");
  });

  it("does not prepare reads, simulation writes or empty assessments", async () => {
    const { prepare, request } = fixture();
    await expect(
      prepare({ ...request, toolName: "lab-real-netbox_netbox_get_objects" }),
    ).rejects.toThrow("native permissions and audit");
    await expect(
      prepare({ ...request, toolName: "lab-sim-netbox_dcim_devices_create" }),
    ).rejects.toThrow("approval environment");
    const empty = clone(PrepareChangeRequestSchema, request);
    assert(empty.plan);
    empty.plan.impact = " ";
    await expect(prepare(empty)).rejects.toThrow("impact");
  });

  it("binds preparation to exact parameters and the preceding successful native call", async () => {
    const { prepare, request } = fixture();
    const response = await prepare(request);
    const call = create(ToolCallSchema, {
      id: "prepare",
      name: "mcp__team-sessions__prepare_change",
      state: ActivityState.SUCCEEDED,
      output: fromJson(ValueSchema, toJson(PrepareChangeResponseSchema, response)),
    });
    const write = create(ToolCallSchema, { id: "write", name: request.toolName });
    expect(preparedChange([call, write], "write", request.toolName, request.args ?? {})).toEqual(
      response,
    );
    expect(preparedChange([call, write], "write", request.toolName, { site: 2 })).toBeUndefined();
    expect(
      preparedChange([write, call], "write", request.toolName, request.args ?? {}),
    ).toBeUndefined();
    call.state = ActivityState.FAILED;
    expect(
      preparedChange([call, write], "write", request.toolName, request.args ?? {}),
    ).toBeUndefined();
    call.state = ActivityState.SUCCEEDED;
    response.simulationReport = "";
    call.output = fromJson(ValueSchema, toJson(PrepareChangeResponseSchema, response));
    expect(
      preparedChange([call, write], "write", request.toolName, request.args ?? {}),
    ).toBeUndefined();
  });
});
