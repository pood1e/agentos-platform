import { Capability, CapabilitySchema } from "../gen/agentos/authorization/v1/permission_pb.js";
import type { ResourceProposal } from "../gen/agentos/evaluation/v1/evaluation_pb.js";
import { object, text } from "./json.js";

export const administratorRole = "agentos-admin";

export const allCapabilities = CapabilitySchema.values
  .map((value) => value.number)
  .filter((value) => value !== Capability.UNSPECIFIED);

export function capabilityRole(capability: Capability) {
  const value = CapabilitySchema.values.find((value) => value.number === capability);
  if (!value || capability === Capability.UNSPECIFIED) throw new Error("Unknown capability");
  return `agentos-${value.name.slice("CAPABILITY_".length).toLowerCase().replaceAll("_", "-")}`;
}

export function roleCapabilities(roles: unknown) {
  return allCapabilities.filter(
    (capability) => Array.isArray(roles) && roles.includes(capabilityRole(capability)),
  );
}

export function can(
  profile: { capabilities: readonly Capability[] } | undefined,
  capability: Capability,
) {
  return profile?.capabilities.includes(capability) === true;
}

export function intersectCapabilities(...ceilings: (readonly Capability[])[]) {
  return (ceilings[0] ?? []).filter((capability) =>
    ceilings.every((ceiling) => ceiling.includes(capability)),
  );
}

export function publicationCapabilities(proposals: ResourceProposal[]) {
  const permissions = proposals.flatMap(({ resource }) => {
    if (!resource?.value || resource.kind !== resource.value.kind) return [Capability.UNSPECIFIED];
    switch (resource.kind) {
      case "Agent":
      case "AgentTemplate":
        return [Capability.AGENTS_MANAGE];
      case "Harness":
        return [Capability.HARNESSES_MANAGE];
      case "AgentgatewayModel":
      case "ModelConfig":
        return [Capability.MODELS_MANAGE];
      case "AgentgatewayBackend":
      case "RemoteMCPServer":
        return [Capability.MCP_MANAGE];
      case "ConfigMap":
        return [Capability.SKILLS_MANAGE];
      case "Secret":
      case "HTTPRoute":
      case "AgentgatewayPolicy": {
        const owners = object(resource.value.metadata).ownerReferences;
        return Array.isArray(owners) && owners.length
          ? owners.map((owner) => {
              const kind = text(object(owner).kind);
              return kind === "AgentgatewayModel"
                ? Capability.MODELS_MANAGE
                : kind === "AgentgatewayBackend"
                  ? Capability.MCP_MANAGE
                  : Capability.UNSPECIFIED;
            })
          : [Capability.UNSPECIFIED];
      }
      default:
        return [Capability.UNSPECIFIED];
    }
  });
  return [...new Set(permissions)];
}
