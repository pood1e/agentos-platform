import type { JsonValue } from "@bufbuild/protobuf";
import { object } from "../../shared/json.js";

export const isWorkflowTemplate = (spec: JsonValue | undefined) =>
  object(spec).workflowFrom !== undefined;
