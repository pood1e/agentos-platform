import type { JsonValue } from "@bufbuild/protobuf";
import type { CoreV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import { parseDocument } from "yaml";
import { object } from "../../../shared/json.js";

const referenceFields = new Set([
  "workflowFrom",
  "systemPromptFrom",
  "outputSchemaFrom",
  "configMapKeyRef",
  "configMapRef",
  "configMap",
]);

/** Namespace-wide references are independent of the caller's filtered native catalog. */
export async function workflowReferences(
  custom: CustomObjectsApi,
  core: CoreV1Api,
  namespace: string,
  candidate: string,
) {
  const names = new Set<string>();
  const sources = new Map<string, { name: string; key: string }>();
  function visit(value: JsonValue) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object")
      for (const [field, child] of Object.entries(value)) {
        const name = object(child).name;
        if (referenceFields.has(field) && typeof name === "string") names.add(name);
        const key = object(child).key;
        if (field === "workflowFrom" && typeof name === "string" && typeof key === "string")
          sources.set(`${name}/${key}`, { name, key });
        if (field === "dataSources" && Array.isArray(child))
          for (const source of child) {
            const name = object(source).name;
            if (typeof name === "string") names.add(name);
          }
        visit(child);
      }
  }
  for (const plural of ["agents", "agenttemplates", "harnesses", "modelconfigs"]) {
    let continuation = "";
    do {
      const page = await custom.listNamespacedCustomObject({
        group: "api.kagent.dev",
        version: "v1alpha3",
        namespace,
        plural,
        limit: 500,
        _continue: continuation,
      });
      visit(page.items);
      continuation = page.metadata?.continue ?? "";
    } while (continuation);
  }
  function visitDocument(document: string) {
    if (Buffer.byteLength(document) > 65_536) throw new Error("Workflow source exceeds 64 KiB");
    const parsed = parseDocument(document, { uniqueKeys: true });
    if (parsed.errors.length) throw parsed.errors[0];
    visit(parsed.toJS({ maxAliasCount: 0 }));
  }
  visitDocument(candidate);
  for (const { name, key } of sources.values()) {
    const source = await core.readNamespacedConfigMap({ namespace, name });
    const value = source.data?.[key];
    if (value === undefined) throw new Error(`Workflow source ${name}/${key} is unavailable`);
    visitDocument(value);
  }
  return names;
}
