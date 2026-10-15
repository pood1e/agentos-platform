import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { ActivityState } from "../gen/agentos/console/v1/state_pb.js";
import { ToolCallSchema } from "../gen/agentos/console/v1/task_pb.js";
import { approvalEvidence } from "../server/operations/evidence.js";
import { fixtureCatalog } from "./harness.js";

const read = (
  id: string,
  name: string,
  output: JsonValue = { observed: true },
  state = ActivityState.SUCCEEDED,
) => create(ToolCallSchema, { id, name, state, output: fromJson(ValueSchema, output) });

it("reviews actual preceding observations without including writes or other environments", () => {
  const evidence = approvalEvidence(
    [
      read("namespace", "sim-kubernetes-reader.lab-sim-kubernetes_pods_list"),
      read("absent", "lab-sim-kubernetes_resources_get", "NotFound", ActivityState.FAILED),
      read("other", "lab-real-kubernetes_pods_list"),
      read("write", "lab-sim-kubernetes_resources_create_or_update"),
      read("oversized", "lab-sim-kubernetes_pods_list", "x".repeat(9000)),
      read("paused", "lab-sim-kubernetes_resources_create_or_update"),
      read("later", "lab-sim-kubernetes_pods_list"),
    ],
    "paused",
    "lab-sim",
    fixtureCatalog(),
  );
  expect(evidence.map((item) => item.id)).toEqual(["namespace", "absent"]);
  expect(evidence[0]?.name).toBe("lab-sim-kubernetes_pods_list");
});

it("bounds evidence and fails closed when the paused call cannot be located", () => {
  const calls = Array.from({ length: 9 }, (_, index) =>
    read(String(index), "lab-sim-kubernetes_pods_list"),
  );
  calls.push(read("paused", "lab-sim-kubernetes_resources_create_or_update"));
  expect(
    approvalEvidence(calls, "paused", "lab-sim", fixtureCatalog()).map((item) => item.id),
  ).toEqual(["3", "4", "5", "6", "7", "8"]);
  expect(approvalEvidence(calls, "missing", "lab-sim", fixtureCatalog())).toEqual([]);
});
