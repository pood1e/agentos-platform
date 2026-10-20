import { readFileSync } from "node:fs";
import { fromJsonString } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { GovernanceConfigSchema } from "../../gen/agentos/governance/v1/governance_pb.js";

export function governanceConfig(path = process.env.AGENTOS_GOVERNANCE_CONFIG) {
  const config = path
    ? fromJsonString(GovernanceConfigSchema, readFileSync(path, "utf8"))
    : fromJsonString(GovernanceConfigSchema, "{}");
  const result = createValidator().validate(GovernanceConfigSchema, config);
  if (result.kind !== "valid") throw new Error(String(result.error));
  const names = config.environments.map((item) => item.environment?.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate environment");
  return config;
}
