import { expect, it } from "vitest";
import { toolOutcome } from "../server/read-model/decode/tools.js";

it("preserves MCP text when an adapter emits a null structured result", () => {
  expect(
    toolOutcome({
      result: {
        structuredContent: null,
        content: [{ type: "text", text: "Namespace agentos-lab Active" }],
      },
    }),
  ).toEqual({ kind: "output", value: "Namespace agentos-lab Active" });
});

it("preserves native NotFound evidence and failure state", () => {
  expect(
    toolOutcome({
      isError: true,
      result: {
        structuredContent: null,
        content: [{ type: "text", text: "ConfigMap qa-glpi-test not found" }],
      },
    }),
  ).toEqual({ kind: "error", value: "ConfigMap qa-glpi-test not found" });
});
