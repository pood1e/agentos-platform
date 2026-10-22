import type { JsonObject } from "@bufbuild/protobuf";
import type { Harness } from "../../gen/kagent/api/v1/harnesses_pb.js";
import type { ModelConfig } from "../../gen/kagent/api/v1/models_pb.js";
import type { ToolServer } from "../../gen/kagent/api/v1/tools_pb.js";
import { harnessModelIssue, harnessToolsIssue } from "../../shared/harness-model.js";
import { object } from "../read-model/decode/messages.js";
import { invalid } from "../shared/errors.js";

/** Checks the pinned native adapters' model and MCP selection constraints before assignment. */
export function validateHarness(
  harness: Harness,
  model: ModelConfig | undefined,
  template: JsonObject,
  servers: ToolServer[],
) {
  if (harness.runtime !== "codex" && harness.runtime !== "claude") return;
  const issue =
    harnessModelIssue(harness.runtime, object(model?.resource?.value?.spec)) ??
    harnessToolsIssue(harness.runtime, template, harness.ref?.namespace ?? "", servers);
  if (issue) throw invalid(issue);
}
