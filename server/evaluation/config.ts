import { readFileSync } from "node:fs";
import { fromJsonString } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { EvaluationConfigurationSchema } from "../../gen/agentos/evaluation/v1/evaluation_pb.js";

export function evaluationConfig(env = process.env) {
  if (!env.AGENTOS_EVALUATION_CONFIG) return undefined;
  const value = fromJsonString(
    EvaluationConfigurationSchema,
    readFileSync(env.AGENTOS_EVALUATION_CONFIG, "utf8"),
  );
  const result = createValidator().validate(EvaluationConfigurationSchema, value);
  if (result.kind !== "valid") throw new Error(`Invalid evaluation configuration: ${result.error}`);
  return value;
}
