import type { JsonObject } from "@bufbuild/protobuf";
import { ModelPurpose } from "../gen/agentos/management/v1/management_pb.js";
import { object } from "./json.js";

export const modelPurposeAnnotation = "agentos.dev/model-purpose";

export function modelPurpose(resource: JsonObject | undefined): ModelPurpose {
  return object(object(resource?.metadata).annotations)[modelPurposeAnnotation] === "embedding"
    ? ModelPurpose.EMBEDDING
    : ModelPurpose.LANGUAGE;
}
