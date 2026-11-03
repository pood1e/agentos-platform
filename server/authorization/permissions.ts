import { type DescMethod, isMessage } from "@bufbuild/protobuf";
import { MethodOptions_IdempotencyLevel } from "@bufbuild/protobuf/wkt";
import type { UserIdentity } from "../../gen/agentos/authorization/v1/identity_pb.js";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { ConsoleService } from "../../gen/agentos/console/v1/console_service_pb.js";
import {
  ConnectionKind,
  DeleteConnectionRequestSchema,
  ManagementService,
  SaveConnectionRequestSchema,
} from "../../gen/agentos/management/v1/management_pb.js";
import { can } from "../../shared/permissions.js";

const key = (method: DescMethod) => `${method.parent.typeName}/${method.name}`;
const requirements = new Map<string, Capability>([
  [key(ConsoleService.method.createRole), Capability.AGENTS_MANAGE],
  [key(ConsoleService.method.updateRole), Capability.AGENTS_MANAGE],
  [key(ManagementService.method.setAgentRuntime), Capability.AGENTS_MANAGE],
  [key(ManagementService.method.validateWorkflow), Capability.AGENTS_MANAGE],
  [key(ManagementService.method.publishWorkflow), Capability.AGENTS_MANAGE],
  [key(ManagementService.method.saveWorkflowLayout), Capability.AGENTS_MANAGE],
  [key(ManagementService.method.saveSpeechConfiguration), Capability.MODELS_MANAGE],
  [key(ManagementService.method.saveSkill), Capability.SKILLS_MANAGE],
  [key(ManagementService.method.deleteSkill), Capability.SKILLS_MANAGE],
  [key(ManagementService.method.addKnowledge), Capability.KNOWLEDGE_MANAGE],
  [key(ManagementService.method.deleteKnowledge), Capability.KNOWLEDGE_MANAGE],
  [key(ManagementService.method.clearKnowledge), Capability.KNOWLEDGE_MANAGE],
  [key(ManagementService.method.saveHarness), Capability.HARNESSES_MANAGE],
  [key(ManagementService.method.deleteHarness), Capability.HARNESSES_MANAGE],
]);

/** Commands on the caller's own work; native authority decides them per resource. */
const selfService = new Set(
  [
    ConsoleService.method.sendMessage,
    ConsoleService.method.callAppTool,
    ConsoleService.method.deleteSession,
    ConsoleService.method.respondInteraction,
    ConsoleService.method.cancelTask,
    ConsoleService.method.startVoiceSession,
  ].map(key),
);

/** Connection permissions follow the authoritative kind in the request. */
function requiredCapability(method: DescMethod, message: unknown) {
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

/** Reads and self-service commands pass; unknown mutations fail closed. */
export function mayCall(principal: UserIdentity, method: DescMethod, message: unknown) {
  if (
    method.idempotency === MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS ||
    selfService.has(key(method))
  )
    return true;
  const capability = requiredCapability(method, message);
  return capability !== undefined && can(principal, capability);
}
