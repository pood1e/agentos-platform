import { type DescMethod, isMessage } from "@bufbuild/protobuf";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import { EvaluationService } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";
import {
  ConnectionKind,
  DeleteConnectionRequestSchema,
  ManagementService,
  SaveConnectionRequestSchema,
} from "../../gen/agentos/management/v1/management_pb.js";

const key = (method: DescMethod) => `${method.parent.typeName}/${method.name}`;
const requirements = new Map<string, Capability>([
  [key(ConsoleService.method.createRole), Capability.AGENTS_MANAGE],
  [key(ConsoleService.method.updateRole), Capability.AGENTS_MANAGE],
  [key(ManagementService.method.setEngineerRuntime), Capability.AGENTS_MANAGE],
  [key(ManagementService.method.saveSkill), Capability.SKILLS_MANAGE],
  [key(ManagementService.method.deleteSkill), Capability.SKILLS_MANAGE],
  [key(ManagementService.method.addKnowledge), Capability.KNOWLEDGE_MANAGE],
  [key(ManagementService.method.deleteKnowledge), Capability.KNOWLEDGE_MANAGE],
  [key(ManagementService.method.clearKnowledge), Capability.KNOWLEDGE_MANAGE],
  [key(ManagementService.method.saveHarness), Capability.HARNESSES_MANAGE],
  [key(ManagementService.method.deleteHarness), Capability.HARNESSES_MANAGE],
  [key(EvaluationService.method.runEvaluation), Capability.EVALUATIONS_MANAGE],
  [key(EvaluationService.method.publishCandidate), Capability.EVALUATIONS_MANAGE],
]);

/** Unknown mutations fail closed; connection permissions follow the authoritative kind. */
export function requiredCapability(method: DescMethod, message: unknown) {
  let kind: ConnectionKind | undefined;
  if (
    key(method) === key(ManagementService.method.saveConnection) &&
    isMessage(message, SaveConnectionRequestSchema)
  )
    kind = message.connection?.kind;
  else if (
    key(method) === key(ManagementService.method.deleteConnection) &&
    isMessage(message, DeleteConnectionRequestSchema)
  )
    kind = message.kind;
  if (kind === ConnectionKind.MCP) return Capability.MCP_MANAGE;
  if (kind === ConnectionKind.MODEL) return Capability.MODELS_MANAGE;
  return requirements.get(key(method));
}
