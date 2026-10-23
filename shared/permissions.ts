import { Capability, CapabilitySchema } from "../gen/agentos/authorization/v1/permission_pb.js";

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

export function isAdministrator(profile: { capabilities: readonly Capability[] } | undefined) {
  return allCapabilities.some((capability) => can(profile, capability));
}

export function intersectCapabilities(...ceilings: (readonly Capability[])[]) {
  return (ceilings[0] ?? []).filter((capability) =>
    ceilings.every((ceiling) => ceiling.includes(capability)),
  );
}
