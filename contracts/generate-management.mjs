import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

mkdirSync("gen/schema", { recursive: true });
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

const executionSource = JSON.parse(
  readFileSync(
    "gen/schema/agentos.authorization.v1.ExecutionSource.jsonschema.bundle.json",
    "utf8",
  ),
);
Object.assign(chartSchema.$defs, executionSource.$defs);
chartSchema.properties.execution.properties.sources = {
  type: "array",
  items: { $ref: executionSource.$ref },
  maxItems: 32,
};
writeFileSync("charts/agentos/values.schema.json", `${JSON.stringify(chartSchema, null, 2)}\n`);

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
