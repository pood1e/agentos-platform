import { createHash } from "node:crypto";
import { type JsonValue, toJson } from "@bufbuild/protobuf";
import canonicalize from "canonicalize";
import {
  type ChangeRequest,
  ChangeRequestSchema,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { changeProposal } from "./change-proposal.js";

export function digest(value: JsonValue): string {
  const json = canonicalize(value);
  if (json === undefined) throw new Error("Change payload must be JSON");
  return createHash("sha256").update(json).digest("hex");
}

export const changeId = (taskId: string, approvalId: string) =>
  digest({ task: taskId, approval: approvalId });

export const planHash = (request: ChangeRequest) =>
  digest(toJson(ChangeRequestSchema, changeProposal(request)));

export function callHash(engineer: string, tool: string, args: JsonValue): string {
  return digest({ engineer, tool, args });
}

export const operationHash = (tool: string, args: JsonValue) => digest({ tool, args });
