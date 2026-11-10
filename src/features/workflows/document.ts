import { create } from "@bufbuild/protobuf";
import { type Document, parseDocument } from "yaml";
import {
  type WorkflowLayout,
  WorkflowLayoutSchema,
  WorkflowNodePositionSchema,
} from "../../../gen/agentos/management/v1/workflow_pb.js";
import type { AgentSystem, Node as WorkflowNode } from "../../../gen/kagent/workflow.js";

type DocumentPath = (string | number)[];
type AgentDefinition = NonNullable<AgentSystem["agents"]>[number];
export type GraphScope = {
  id: string;
  path: DocumentPath;
  nodes: WorkflowNode[];
  edges: NonNullable<AgentDefinition["edges"]>;
  entry?: string;
};

export const initialDocument = `apiVersion: adk.declarative/v0.2
kind: AgentSystem
agents:
  - name: workflow
    agent_class: Workflow
    entry: result
    nodes:
      - id: result
        type: cel
        output: input
`;

export function nativeDocument(source: string) {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw document.errors[0];
  const value = document.toJS({ maxAliasCount: 0 }) as AgentSystem;
  if (
    value?.apiVersion !== "adk.declarative/v0.2" ||
    value.kind !== "AgentSystem" ||
    !Array.isArray(value.agents)
  )
    throw new Error("adk.declarative/v0.2 AgentSystem required");
  return { document, value };
}

export function editDocument(source: string, edit: (document: Document) => void) {
  const { document } = nativeDocument(source);
  edit(document);
  return document.toString();
}

export function graphScopes(value: AgentSystem): GraphScope[] {
  const scopes: GraphScope[] = [];
  const visit = (
    id: string,
    path: DocumentPath,
    graph: { nodes?: WorkflowNode[] | null; edges?: GraphScope["edges"] | null; entry?: string },
  ) => {
    if (!Array.isArray(graph.nodes)) return;
    if (
      graph.nodes.some(
        (node) => !node || typeof node.id !== "string" || typeof node.type !== "string",
      ) ||
      (graph.edges !== undefined && graph.edges !== null && !Array.isArray(graph.edges)) ||
      graph.edges?.some(
        (edge) => !edge || typeof edge.from !== "string" || typeof edge.to !== "string",
      )
    )
      throw new Error("Invalid native graph shape");
    scopes.push({ id, path, nodes: graph.nodes, edges: graph.edges ?? [], entry: graph.entry });
    graph.nodes.forEach((node, index) => {
      if (node.type === "workflow") visit(`${id}/${node.id}`, [...path, "nodes", index], node);
    });
  };
  value.agents?.forEach((agent, index) => {
    if (!agent || typeof agent.name !== "string") throw new Error("Invalid native Agent shape");
    visit(agent.name, ["agents", index], agent);
  });
  return scopes;
}

export function replaceNode(source: string, scope: GraphScope, index: number, node: WorkflowNode) {
  const previous = scope.nodes[index].id;
  if (node.id !== previous && scope.nodes.some((item) => item.id === node.id))
    throw new Error("Duplicate node ID");
  return editDocument(source, (document) => {
    document.setIn([...scope.path, "nodes", index], node);
    if (node.id === previous) return;
    const edges = scope.edges.map((edge) => ({
      ...edge,
      from: edge.from === previous ? node.id : edge.from,
      to: edge.to === previous ? node.id : edge.to,
    }));
    document.setIn([...scope.path, "edges"], edges);
    if (scope.entry === previous) document.setIn([...scope.path, "entry"], node.id);
    scope.nodes.forEach((item, i) => {
      if (item.type === "dynamic" && item.children?.includes(previous))
        document.setIn(
          [...scope.path, "nodes", i, "children"],
          item.children.map((child) => (child === previous ? node.id : child)),
        );
    });
  });
}

export function removeNodes(source: string, scope: GraphScope, ids: string[]) {
  return editDocument(source, (document) => {
    document.setIn(
      [...scope.path, "nodes"],
      scope.nodes
        .filter((node) => !ids.includes(node.id))
        .map((node) =>
          node.type === "dynamic"
            ? { ...node, children: node.children?.filter((child) => !ids.includes(child)) }
            : node,
        ),
    );
    document.setIn(
      [...scope.path, "edges"],
      scope.edges.filter((edge) => !ids.includes(edge.from) && !ids.includes(edge.to)),
    );
    if (scope.entry && ids.includes(scope.entry)) document.deleteIn([...scope.path, "entry"]);
  });
}

export const edgeKey = (edge: GraphScope["edges"][number]) =>
  JSON.stringify([edge.from, edge.to, edge.route ?? ""]);

export function appendEdge(source: string, scope: GraphScope, from: string, to: string) {
  if (
    to === "START" ||
    !scope.nodes.some((node) => node.id === to) ||
    (from !== "START" && !scope.nodes.some((node) => node.id === from))
  )
    return source;
  if (
    scope.edges.some((edge) => edge.from === from && edge.to === to && !edge.route) ||
    (from === "START" && scope.entry === to)
  )
    return source;
  return editDocument(source, (document) =>
    document.setIn([...scope.path, "edges"], [...scope.edges, { from, to }]),
  );
}

export function position(layout: WorkflowLayout, path: string, x: number, y: number) {
  return create(WorkflowLayoutSchema, {
    nodes: [
      ...layout.nodes.filter((node) => node.path !== path),
      create(WorkflowNodePositionSchema, { path, x, y }),
    ],
  });
}

export function newNode(type: WorkflowNode["type"], scope: GraphScope): WorkflowNode {
  let suffix = scope.nodes.length + 1;
  while (scope.nodes.some((node) => node.id === `${type}_${suffix}`)) suffix++;
  const id = `${type}_${suffix}`;
  switch (type) {
    case "agent":
      return { id, type, agent_ref: { name: "" } };
    case "llm":
      return { id, type, model: "template:model", instruction: "" };
    case "tool":
      return { id, type, server: "", tool: "" };
    case "hitl":
      return { id, type, message: "" };
    case "workflow":
      return {
        id,
        type,
        nodes: [{ id: "result", type: "cel", output: "input" }],
        edges: [{ from: "START", to: "result" }],
      };
    case "parallel_worker":
      return { id, type, agent_ref: { name: "" }, max_concurrency: 2 };
    case "join":
      return { id, type };
    default:
      return { id, type: "cel", output: "input" };
  }
}
