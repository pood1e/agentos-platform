import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { compile } from "json-schema-to-typescript";
import { parse } from "yaml";

mkdirSync("gen/schema", { recursive: true });
const workflow = JSON.parse(readFileSync("third_party/kagent-crds/workflow.schema.json", "utf8"));
writeFileSync(
  "gen/kagent/workflow.ts",
  await compile(workflow, "AgentSystem", {
    bannerComment: "/* Generated from the pinned kagent declarative schema. */",
    additionalProperties: false,
  }),
);
for (const [file, name] of [
  ["models", "model"],
  ["backends", "mcp"],
]) {
  const crd = parse(readFileSync(`third_party/agentgateway/${file}.yaml`, "utf8"));
  const schema = crd.spec.versions.find((version) => version.name === "v1alpha1").schema
    .openAPIV3Schema.properties.spec;
  writeFileSync(`gen/schema/agentgateway.${name}.json`, `${JSON.stringify(schema)}\n`);
}
const harness = parse(readFileSync("third_party/kagent-crds/harnesses.yaml", "utf8"));
const harnessSchema = harness.spec.versions.find((version) => version.name === "v1alpha3").schema
  .openAPIV3Schema.properties.spec;
writeFileSync("gen/schema/kagent.harness.json", `${JSON.stringify(harnessSchema)}\n`);
const chartSchema = JSON.parse(readFileSync("charts/agentos/values.schema.json", "utf8"));
if (JSON.stringify(chartSchema.$defs.harnessSpec) !== JSON.stringify(harnessSchema))
  throw new Error("Chart harnessSpec must match the pinned native Harness schema");

await import("./generate-kubernetes.mjs");

execFileSync(
  "node_modules/.bin/biome",
  [
    "format",
    "--write",
    "charts/agentos/values.schema.json",
    "charts/agentos-environment/values.schema.json",
    "charts/agentos-connections/values.schema.json",
  ],
  { stdio: "ignore" },
);
