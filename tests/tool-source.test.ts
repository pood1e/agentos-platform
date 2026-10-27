import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { ToolServerSchema } from "../gen/kagent/api/v1/tools_pb.js";
import { toolSource } from "../src/features/shared/tool-source.js";

it("resolves live gateway calls to the service instead of an arbitrary role credential profile", () => {
  const names = [
    "aiops-real-kubernetes_pods_list_in_namespace",
    "aiops-real-kubernetes_namespaces_list",
  ];
  const servers = [
    "aiops-real-kubernetes-supervisor",
    "aiops-real-kubernetes-inspection",
    "aiops-real-kubernetes",
  ].map((name) =>
    create(ToolServerSchema, {
      ref: `workspace/${name}`,
      discoveredTools: names.map((name) => ({ name, description: "Read Kubernetes resources" })),
    }),
  );
  for (const order of [servers, [...servers].reverse()])
    expect(names.map((name) => toolSource(order, name).server?.ref)).toEqual([
      "workspace/aiops-real-kubernetes",
      "workspace/aiops-real-kubernetes",
    ]);
});

it("retains bare discovery names and resolves explicitly qualified wrapper names", () => {
  const servers = ["cluster-reader", "cluster"].map((name) =>
    create(ToolServerSchema, {
      ref: `workspace/${name}`,
      discoveredTools: [{ name: "pods_list", description: "List pods" }],
    }),
  );
  expect(toolSource(servers, "mcp__cluster__pods_list").server?.ref).toBe("workspace/cluster");
  expect(toolSource(servers.slice(1), "pods_list").tool?.description).toBe("List pods");
  expect(toolSource(servers, "unknown").server).toBeUndefined();
});

it("uses the most specific discovered service qualifier", () => {
  const servers = ["ops", "ops_cluster"].map((name) =>
    create(ToolServerSchema, {
      ref: `workspace/${name}`,
      discoveredTools: [{ name: "ops_cluster_pods_list" }],
    }),
  );
  expect(toolSource(servers, "ops_cluster_pods_list").server?.ref).toBe("workspace/ops_cluster");
});
