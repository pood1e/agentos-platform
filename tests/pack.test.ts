import { expect, it } from "vitest";
import { parsePack } from "../src/lib/pack.js";

it("reads the pack schema and skips tool patterns that do not compile", () => {
  const pack = parsePack({
    title: "Operations",
    tools: [
      { match: "^grafana", name: "Grafana", icon: "grafana.svg" },
      { match: "(", name: "Broken", icon: "broken.svg" },
    ],
  });
  expect(pack.title).toBe("Operations");
  expect(pack.tools.map((tool) => tool.name)).toEqual(["Grafana"]);
  expect(() => parsePack({ theme: "dark" })).toThrow();
});
