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

it("accepts unique, named schedule templates for workspace Agents", () => {
  const template = (name: string) => ({
    agent: { namespace: "agentos", name: "daily-report" },
    config: { name, schedule: "30 8 * * *", timeZone: "Asia/Shanghai", prompt: "Report" },
  });
  expect(parsePack({ schedules: [template("Daily report")] }).schedules[0]?.config?.name).toBe(
    "Daily report",
  );
  expect(() => parsePack({ schedules: [template("Daily"), template("Daily")] })).toThrow();
  expect(() => parsePack({ schedules: [template("")] })).toThrow();
  expect(() => parsePack({ schedules: [{ config: template("Daily").config }] })).toThrow();
});
