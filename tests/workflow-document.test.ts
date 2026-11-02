import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { WorkflowLayoutSchema } from "../gen/agentos/management/v1/workflow_pb.js";
import {
  appendEdge,
  editDocument,
  graphScopes,
  initialDocument,
  nativeDocument,
  position,
  removeNodes,
  replaceNode,
} from "../src/features/workflows/document.js";

it("round-trips untouched native fields and comments through canvas edits", () => {
  const source = `${initialDocument}    max_concurrency: 2 # keep this limit\n`;
  const scope = graphScopes(nativeDocument(source).value)[0];
  const updated = replaceNode(source, scope, 0, { ...scope.nodes[0], id: "finish" });
  const parsed = nativeDocument(updated).value;
  expect(parsed.agents?.[0].entry).toBe("finish");
  expect(parsed.agents?.[0].max_concurrency).toBe(2);
  expect(updated).toContain("# keep this limit");
});

it("keeps routing semantics native, including conditional back edges", () => {
  const source = editDocument(initialDocument, (document) =>
    document.setIn(
      ["agents", 0, "nodes"],
      [
        { id: "first", type: "cel", output: "input" },
        { id: "second", type: "cel", route: "'again'" },
      ],
    ),
  );
  const scope = graphScopes(nativeDocument(source).value)[0];
  const next = appendEdge(source, scope, "second", "first");
  expect(nativeDocument(next).value.agents?.[0].edges).toEqual([{ from: "second", to: "first" }]);
  expect(appendEdge(source, scope, "first", "START")).toBe(source);
});

it("projects nested scopes and removes local edges with their nodes", () => {
  const source = editDocument(initialDocument, (document) => {
    document.setIn(
      ["agents", 0, "nodes"],
      [
        {
          id: "child",
          type: "workflow",
          nodes: [{ id: "done", type: "cel", output: "input" }],
          edges: [{ from: "START", to: "done" }],
        },
      ],
    );
    document.setIn(["agents", 0, "entry"], "child");
  });
  const scopes = graphScopes(nativeDocument(source).value);
  expect(scopes.map((scope) => scope.id)).toEqual(["workflow", "workflow/child"]);
  const next = removeNodes(source, scopes[1], ["done"]);
  expect(graphScopes(nativeDocument(next).value)[1].edges).toEqual([]);
  expect(graphScopes(nativeDocument(next).value)[0].entry).toBe("child");
});

it("saves layout independently and rejects malformed documents", () => {
  const layout = create(WorkflowLayoutSchema);
  expect(position(layout, "workflow/result", 10, 20).nodes).toHaveLength(1);
  expect(layout.nodes).toHaveLength(0);
  expect(() => nativeDocument("agents: []")).toThrow();
  expect(() => nativeDocument("apiVersion: a\napiVersion: b")).toThrow();
});
