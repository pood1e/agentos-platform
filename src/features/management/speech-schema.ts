import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import type { RJSFSchema } from "@rjsf/utils";
import type { TFunction } from "i18next";
import { localizedSchema, object } from "./connection-schema.js";

export function speechSchema(source: JsonObject, t: TFunction): RJSFSchema {
  const bundle = structuredClone(source);
  function canonical(value: JsonValue) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) canonical(item);
      return;
    }
    delete value.$schema;
    if (Array.isArray(value.anyOf)) {
      const variants = value.anyOf.map(object).find((item) => Array.isArray(item.enum));
      if (Array.isArray(variants?.enum)) {
        delete value.anyOf;
        value.type = "string";
        value.default = variants.enum[0];
        value.oneOf = variants.enum.map((item) => ({
          const: item,
          title: t(`management.speech.protocols.${item}`),
        }));
      }
    }
    for (const child of Object.values(value)) canonical(child);
  }
  canonical(bundle);
  const definitions = Object.fromEntries(
    Object.entries(object(bundle.$defs)).map(([key, value]) => [
      key,
      localizedSchema(value as RJSFSchema, t, "", "management.speech.fields"),
    ]),
  );
  const name = String(bundle.$ref).slice("#/$defs/".length);
  return { ...definitions[name], $defs: definitions };
}
