import { readFileSync } from "node:fs";
import type { RJSFSchema } from "@rjsf/utils";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { localizedSchema } from "../src/features/management/connection-schema.js";
import i18n from "../src/i18n/index.js";

function harnessSpecSchema(): RJSFSchema {
  const crd = parse(
    readFileSync(new URL("../third_party/kagent-crds/harnesses.yaml", import.meta.url), "utf8"),
  );
  return crd.spec.versions.find((version: { name: string }) => version.name === "v1alpha3").schema
    .openAPIV3Schema.properties.spec;
}

const field = (schema: RJSFSchema, key: string) => schema.properties?.[key] as RJSFSchema;

afterEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("Harness form schema", () => {
  it("labels runtime limits apart from long-term memory and edits quantities as text", async () => {
    await i18n.changeLanguage("en");
    const schema = localizedSchema(harnessSpecSchema(), i18n.t.bind(i18n), "", "harness.fields");
    const resources = field(schema, "resources");
    const cpu = field(resources, "cpu");

    expect(resources.title).toBe("Runtime resources");
    expect(field(resources, "memory").title).toBe("Memory limit");
    expect(field(field(schema, "kagent"), "memory").title).toBe("Long-term memory");
    expect(cpu).toMatchObject({ title: "CPU limit", type: "string" });
    expect(cpu.anyOf).toBeUndefined();
    expect(new RegExp(cpu.pattern ?? "").test("500m")).toBe(true);
  });
});
