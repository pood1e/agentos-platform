import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkflowInteraction } from "../gen/agentos/console/v1/pack_pb.js";
import { Workflows } from "../src/features/engineers/Workflows.js";
import { workflowGraph } from "../src/features/engineers/workflow-graph.js";
import i18n from "../src/i18n/index.js";
import { applyPackLocales, parsePack } from "../src/lib/pack.js";

const sample = {
  roles: [{ role: "operator", avatar: "avatars/operator.webp" }],
  locales: {
    en: { translation: { process: { incident: { title: "Incident workflow" } } } },
    zh: { translation: { process: { incident: { title: "事故流程" } } } },
  },
  workflows: [
    {
      id: "incident",
      title: "process.incident.title",
      stages: [{ row: 0, title: "process.incident.stage" }],
      nodes: [
        {
          id: "start",
          role: "operator",
          kind: "WORKFLOW_NODE_KIND_AGENT",
          title: "process.incident.start",
          row: 0,
          column: 0,
        },
        {
          id: "review",
          role: "",
          kind: "WORKFLOW_NODE_KIND_HUMAN",
          title: "process.incident.review",
          row: 0,
          column: 1,
        },
      ],
      edges: [
        {
          source: "start",
          target: "review",
          label: "process.incident.approval",
          interaction: "WORKFLOW_INTERACTION_ASYNC",
        },
      ],
    },
  ],
};

describe("pack collaboration workflows", () => {
  it("renders declared roles and translations while retaining async handoffs", async () => {
    const pack = parsePack(sample);
    const workflow = pack.workflows[0];
    const graph = workflowGraph(workflow, (key) => `translated:${key}`);
    expect(
      graph.nodes.filter((node) => node.type === "step").map((node) => node.data.title),
    ).toEqual(["translated:process.incident.start", "translated:process.incident.review"]);
    expect(graph.edges[0]).toMatchObject({
      label: "translated:process.incident.approval",
      style: { strokeDasharray: "6 4" },
    });
    expect(workflow.edges[0].interaction).toBe(WorkflowInteraction.ASYNC);
    expect(pack.roles[0].avatar).toBe("avatars/operator.webp");
    expect(renderToStaticMarkup(createElement(Workflows, { workflows: [] }))).toBe("");
    const queryClient = new QueryClient();
    queryClient.setQueryData(["pack"], pack);
    applyPackLocales(pack);
    await i18n.changeLanguage("en");
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Workflows, { workflows: pack.workflows }),
      ),
    );
    expect(html).toContain("Incident workflow");
    expect(html).toContain("avatars/operator.webp");
    await i18n.changeLanguage("zh");
    const chinese = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Workflows, { workflows: pack.workflows }),
      ),
    );
    expect(chinese).toContain("事故流程");
  });
  it("rejects missing roles, invalid references, duplicate positions and workflow IDs", () => {
    const bad = structuredClone(sample);
    bad.workflows[0].edges[0].target = "missing";
    expect(() => parsePack(bad)).toThrow();
    const noRole = structuredClone(sample);
    noRole.workflows[0].nodes[0].role = "";
    expect(() => parsePack(noRole)).toThrow();
    const overlap = structuredClone(sample);
    overlap.workflows[0].nodes[1].column = 0;
    expect(() => parsePack(overlap)).toThrow();
    const duplicate = structuredClone(sample);
    duplicate.workflows.push(structuredClone(duplicate.workflows[0]));
    expect(() => parsePack(duplicate)).toThrow();
  });
});
