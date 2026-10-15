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
