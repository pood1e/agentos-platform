import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { ArtifactSchema, PartSchema, Role, TaskSchema, TaskState } from "../../gen/a2a_pb.js";
import { partTypeKey } from "../../server/read-model/decode/messages.js";

export const batches = [2, 2, 3, 1, 1, 1];
export const notes = [
  "先检查节点和数据源。",
  "接着检查 Pod 用量。",
  "核查磁盘和运行状态。",
  "查看场景指标。",
  "核对告警条件。",
  "确认告警未触发的原因。",
];

export const toolPart = (kind: "function_call" | "function_response", id: string) =>
  create(PartSchema, {
    metadata: { [partTypeKey]: kind },
    content: {
      case: "data",
      value: fromJson(ValueSchema, {
        id,
        name: "k8s_get_resources",
        ...(kind === "function_call"
          ? { args: { namespace: id } }
          : { response: { output: { namespace: id, healthy: true } } }),
      }),
    },
  });

/** Native narration followed by parallel calls, then one artifact with their responses. */
export function orderedChat() {
  return create(TaskSchema, {
    id: "ordered-chat",
    contextId: "ordered-context",
    status: { state: TaskState.WORKING },
    history: [
      {
        messageId: "question",
        role: Role.USER,
        parts: [{ content: { case: "text", value: "检查当前指标" } }],
      },
    ],
    artifacts: batches.flatMap((size, batch) => {
      const ids = Array.from({ length: size }, (_, index) => `read-${batch}-${index}`);
      return [
        create(ArtifactSchema, {
          artifactId: `step-${batch}`,
          parts: [
            { content: { case: "text", value: notes[batch] } },
            ...ids.map((id) => toolPart("function_call", id)),
          ],
        }),
        create(ArtifactSchema, {
          artifactId: `results-${batch}`,
          parts: ids.map((id) => toolPart("function_response", id)),
        }),
      ];
    }),
  });
}
