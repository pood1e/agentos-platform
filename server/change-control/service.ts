import { create, toJson } from "@bufbuild/protobuf";
import { timestampFromDate, ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import {
  type ChangeControlService,
  ChangeSchema,
  ChangeState,
  type Environment,
  Governance,
} from "../../gen/agentos/governance/v1/change_pb.js";
import type { ToolCatalog } from "../operations/catalog.js";
import { callHash } from "../shared/change-digest.js";
import type { ApprovalProvider } from "./provider.js";
import { type ChangeStore, changeRequest } from "./store.js";

export function changeControl(
  store: ChangeStore,
  approvals: ApprovalProvider,
  environment: Environment,
  catalog: ToolCatalog,
) {
  if (environment.governance !== Governance.APPROVAL)
    throw new ConnectError(
      "Change control is only configured for approval environments",
      Code.FailedPrecondition,
    );
  const call = (request: ReturnType<typeof changeRequest>) => {
    const prefix = `${environment.name}-`,
      name = request.tool?.name ?? "";
    if (!name.startsWith(prefix))
      throw new ConnectError("Tool belongs to another environment", Code.PermissionDenied);
    const local = name.slice(prefix.length),
      split = local.indexOf("_"),
      service = local.slice(0, split),
      tool = local.slice(split + 1);
    if (!catalog.projects.has(service))
      throw new ConnectError("Unknown environment service", Code.PermissionDenied);
    return { name: local, service, tool };
  };

  async function get(id: string) {
    const row = await store.get(id),
      request = changeRequest(row);
    const decision = await approvals.decision(row.ticket_id ?? "", id, row.plan_hash);
    const state = row.claimed_at
      ? row.failed === null
        ? ChangeState.EXECUTING
        : row.failed
          ? ChangeState.FAILED
          : ChangeState.SUCCEEDED
      : decision.rejected
        ? ChangeState.REJECTED
        : row.expires_at.getTime() <= Date.now()
          ? ChangeState.EXPIRED
          : row.failed !== null
            ? ChangeState.FAILED
            : decision.approved
              ? ChangeState.APPROVED
              : ChangeState.PENDING;
    return {
      change: create(ChangeSchema, {
        id,
        environment,
        request,
        ticketId: row.ticket_id ?? "",
        ticketUrl: approvals.url(row.ticket_id ?? ""),
        state,
        reason: decision.reason,
        decidedBy: decision.actor,
        expiresAt: timestampFromDate(row.expires_at),
      }),
      planHash: row.plan_hash,
    };
  }

  const rpc: ServiceImpl<typeof ChangeControlService> = {
    async registerChange({ request }) {
      if (!request?.tool?.id || !request.tool.callId)
        throw new ConnectError("A native tool approval is required", Code.InvalidArgument);
      call(request);
      const row = await store.register(
        request,
        callHash(request.engineer, request.tool.name, request.tool.args ?? {}),
        (id, hash) => approvals.create(id, hash, request),
      );
      return { result: await get(row.id) };
    },
    async getChange({ id }) {
      return { result: await get(id) };
    },
    async prepareExecution({ id }) {
      const current = await get(id);
      if (current.change.state !== ChangeState.APPROVED)
        throw new ConnectError("An approved change is required", Code.FailedPrecondition);
      const row = await store.get(id);
      const decision = await approvals.decision(row.ticket_id ?? "", id, row.plan_hash);
      if (!decision.approved)
        throw new ConnectError("Approval was revoked or changed", Code.FailedPrecondition);
      await store.prepare(id, decision.version);
      return { result: await get(id) };
    },
    async recordResult({ id, failed, output }) {
      const row = await store.get(id);
      if (!failed && !row.claimed_at)
        throw new ConnectError(
          "Successful execution requires a claimed approval",
          Code.FailedPrecondition,
        );
      const json = output ? toJson(ValueSchema, output) : null;
      if (await store.result(id, failed, json)) {
        const recorded = await store.get(id);
        await approvals.result(
          row.ticket_id ?? "",
          recorded.failed ?? failed,
          recorded.output,
          !!recorded.claimed_at,
        );
        await store.reported(id);
      }
      return { result: await get(id) };
    },
  };

  async function authorize(engineer: string, tool: string, args: object) {
    const [service = "", ...rest] = tool.split("_");
    if (catalog.projects.get(service)?.get(rest.join("_")) === "read") return;
    const hash = callHash(
      engineer,
      `${environment.name}-${tool}`,
      args as Parameters<typeof callHash>[2],
    );
    return store.claim(hash, async (row) => {
      const request = changeRequest(row);
      if (request.engineer !== engineer || call(request).name !== tool)
        throw new Error("Execution differs from the approved operation");
      const decision = await approvals.decision(row.ticket_id ?? "", row.id, row.plan_hash);
      if (!decision.approved || decision.version !== row.approval_version)
        throw new Error("Approval was revoked or changed");
    });
  }
  return { rpc, get, authorize };
}
