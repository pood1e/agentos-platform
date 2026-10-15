import { create, toJsonString } from "@bufbuild/protobuf";
import { ActivityState } from "../../gen/agentos/console/v1/state_pb.js";
import type { ToolCall } from "../../gen/agentos/console/v1/task_pb.js";
import { ToolActivitySchema } from "../../gen/agentos/kagent/v1/wire_pb.js";
import { toolBaseName } from "../read-model/decode/tools.js";
import type { ToolCatalog } from "./catalog.js";

/** Bound the review evidence to completed read calls preceding the paused operation. */
export function approvalEvidence(
  calls: ToolCall[],
  callId: string,
  environment: string,
  catalog: ToolCatalog,
) {
  const index = calls.findIndex((call) => call.id === callId);
  if (index < 0) return [];
  return calls
    .slice(0, index)
    .flatMap((call) => {
      const name = toolBaseName(call.name);
      const prefix = `${environment}-`;
      let read: boolean;
      if (name.startsWith(prefix)) {
        const local = name.slice(prefix.length),
          split = local.indexOf("_");
        read = catalog.projects.get(local.slice(0, split))?.get(local.slice(split + 1)) === "read";
      } else read = [...catalog.servers.values()].some((tools) => tools.get(name) === "read");
      if (
        !read ||
        !call.output ||
        ![ActivityState.SUCCEEDED, ActivityState.FAILED].includes(call.state)
      )
        return [];
      const evidence = create(ToolActivitySchema, {
        id: call.id,
        name,
        args: call.args,
        response: call.output,
      });
      return Buffer.byteLength(toJsonString(ToolActivitySchema, evidence)) <= 8192
        ? [evidence]
        : [];
    })
    .slice(-6);
}
