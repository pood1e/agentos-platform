import { Code, ConnectError } from "@connectrpc/connect";
import { expect, inject, it } from "vitest";
import { type AccessPlan, serverTargets } from "../shared/access-plans.js";

function fixture() {
  const [compiled] = JSON.parse(inject("accessPlans")) as AccessPlan[];
  if (!compiled?.status || !compiled.metadata) throw new Error("Missing compiled fixture");
  const { status, metadata } = compiled;
  const condition = status.conditions?.find((entry) => entry.type === "Ready");
  const target = status.targets?.[0];
  if (!condition || !target) throw new Error("Missing compiled decisions");
  return { compiled, status, metadata, condition, target };
}

it("reads compiled status decisions rather than spec tool tiers", () => {
  const { compiled, status } = fixture();
  const targets = serverTargets([compiled]);
  expect(targets.size).toBeGreaterThan(0);
  compiled.spec.toolsets = {};
  compiled.spec.identities = [];
  expect(serverTargets([compiled])).toEqual(targets);
  status.targets = [];
  expect(serverTargets([compiled]).size).toBe(0);
});

it.each([
  "missing status",
  "stale status",
  "missing Ready",
  "not Ready",
  "stale Ready",
  "missing generation",
])("rejects %s rather than reinterpreting spec", (state) => {
  const { compiled, status, metadata, condition } = fixture();
  switch (state) {
    case "missing status":
      delete compiled.status;
      break;
    case "stale status":
      status.observedGeneration = 0;
      break;
    case "missing Ready":
      status.conditions = [];
      break;
    case "not Ready":
      condition.status = "False";
      break;
    case "stale Ready":
      condition.observedGeneration = 0;
      break;
    case "missing generation":
      delete metadata.generation;
      delete status.observedGeneration;
  }
  expect(() => serverTargets([compiled])).toThrowError(
    new ConnectError("Authorization plan is not ready", Code.Unavailable),
  );
});

it("rejects conflicting compiled decisions for one server", () => {
  const { compiled } = fixture();
  const { compiled: conflict, target } = fixture();
  target.tools = [];
  expect(() => serverTargets([compiled, conflict])).toThrow("conflicting decisions");
});
