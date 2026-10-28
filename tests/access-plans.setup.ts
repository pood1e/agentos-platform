import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { TestProject } from "vitest/node";
import { parse, stringify } from "yaml";

declare module "vitest" {
  export interface ProvidedContext {
    accessPlans: string;
  }
}

/** Compiles the example toolsets with the platform controller once per test run. */
export default function setup(project: TestProject) {
  const toolsets = parse(readFileSync("tests/fixtures/pack/toolsets.yaml", "utf8"));
  const plan = {
    apiVersion: "agentos.dev/v1alpha1",
    kind: "AccessPlan",
    metadata: { name: "fixture", namespace: "agentos", generation: 1 },
    spec: {
      mode: "platform",
      environments: [{ name: "lab", governance: "approval" }],
      toolsets,
      identities: ["assistant", "coordinator", "inspection", "diagnosis", "remediation"].map(
        (name) => ({
          name,
          services: Object.fromEntries(
            Object.keys(toolsets).map((service) => [
              service,
              name === "remediation" ? "operate" : "read",
            ]),
          ),
        }),
      ),
      servers: parse(readFileSync("tests/fixtures/execution/platform-tools.yaml", "utf8")),
    },
  };
  project.provide(
    "accessPlans",
    execFileSync("go", ["-C", "controller", "run", "./cmd/render", "-format=json"], {
      input: stringify(plan),
      encoding: "utf8",
    }),
  );
}
