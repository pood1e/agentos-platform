import { clone, fromJson, toJson } from "@bufbuild/protobuf";
import {
  type ChangeRequest,
  ChangeRequestSchema,
} from "../../gen/agentos/governance/v1/change_pb.js";
import { redact } from "../../shared/redact.js";

/** The private execution record retains exact arguments; work orders expose a redacted proposal. */
export function changeProposal(request: ChangeRequest) {
  const proposal = clone(ChangeRequestSchema, request);
  proposal.prompt = "";
  return fromJson(ChangeRequestSchema, redact(toJson(ChangeRequestSchema, proposal)));
}
