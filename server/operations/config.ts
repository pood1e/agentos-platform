import { readFileSync } from "node:fs";
import { fromJsonString } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { OperationsConfigSchema } from "../../gen/agentos/governance/v1/change_pb.js";

export function operationsConfig(path = process.env.AGENTOS_OPERATIONS_CONFIG) {
  const config = path
    ? fromJsonString(OperationsConfigSchema, readFileSync(path, "utf8"))
    : fromJsonString(OperationsConfigSchema, "{}");
  const result = createValidator().validate(OperationsConfigSchema, config);
  if (result.kind !== "valid") throw new Error(String(result.error));
  const names = config.environments.map((item) => item.environment?.name);
  if (new Set(names).size !== names.length) throw new Error("Duplicate operations environment");
  return config;
}
