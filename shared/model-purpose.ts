import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { ModelPurpose } from "../gen/agentos/management/v1/management_pb.js";

export const modelPurposeAnnotation = "agentos.dev/model-purpose";

const record = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function modelPurpose(resource: JsonObject | undefined): ModelPurpose {
  return record(record(resource?.metadata).annotations)[modelPurposeAnnotation] === "embedding"
    ? ModelPurpose.EMBEDDING
    : ModelPurpose.LANGUAGE;
}
