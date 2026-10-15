import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import type { RJSFSchema, TranslatableString } from "@rjsf/utils";
import type { TFunction } from "i18next";
import {
  type Connection,
  ConnectionKind,
} from "../../../gen/agentos/management/v1/management_pb.js";
import { toolServerLabel } from "../shared/tool-label.js";

export const object = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const translateSchema = (t: TFunction) => (key: TranslatableString, params?: string[]) =>
  t(`management.schemaLabels.${key}`, { defaultValue: key }).replace(
    /%(\d+)/g,
    (match, index) => params?.[Number(index) - 1] ?? match,
  );
export const native = (connection: Connection) => connection.resource?.value ?? {};
export const metadata = (connection: Connection) => object(native(connection).metadata);
export const connectionName = (connection: Connection) => String(metadata(connection).name ?? "");
export const connectionLabel = (connection: Connection) =>
  String(
    object(metadata(connection).annotations)["agentos.dev/display-name"] ??
      toolServerLabel(connectionName(connection)),
  );
export const connectionProject = (connection: Connection) =>
  String(object(metadata(connection).labels)["agentos.dev/project"] ?? connectionName(connection));
export const connectionEnvironment = (connection: Connection) =>
  String(object(metadata(connection).labels)["agentos.dev/environment"] ?? "");

function pick(schema: RJSFSchema, keys: string[]): RJSFSchema {
  return {
    ...schema,
    properties: Object.fromEntries(
      keys
        .filter((key) => schema.properties?.[key])
        .map((key) => [key, schema.properties?.[key] ?? false]),
    ),
    required: schema.required?.filter((key) => keys.includes(key)),
  };
}

export function localizedSchema(
  schema: RJSFSchema,
  t: TFunction,
  name = "",
  prefix = "management.fields",
): RJSFSchema {
  const next: RJSFSchema = {
    ...schema,
    title: t(`${prefix}.${name}`, { defaultValue: name }),
    description: undefined,
  };
  if (next.format && !["uri", "email", "date", "date-time"].includes(next.format))
    delete next.format;
  // Kubernetes patterns use Go's POSIX space class; AJV compiles ECMAScript patterns.
  if (next.pattern) next.pattern = next.pattern.replaceAll("[:space:]", "\\t\\n\\v\\f\\r ");
  for (const key of Object.keys(next))
    if (key.startsWith("x-")) delete (next as Record<string, unknown>)[key];
  if (next.properties)
    next.properties = Object.fromEntries(
      Object.entries(next.properties).map(([key, value]) => [
        key,
        typeof value === "object" ? localizedSchema(value, t, key, prefix) : value,
      ]),
    );
  if (typeof next.items === "object" && !Array.isArray(next.items))
    next.items = localizedSchema(next.items, t, "target", prefix);
  return next;
}

/** Native schema fragments drive the form; Kubernetes validates the complete resource. */
export function connectionSchema(
  source: JsonObject,
  kind: ConnectionKind,
  t: TFunction,
): RJSFSchema {
  let schema = pick(
    source as RJSFSchema,
    kind === ConnectionKind.MODEL ? ["provider", "baseURL", "match"] : ["mcp"],
  );
  if (kind === ConnectionKind.MODEL) {
    const provider = schema.properties?.provider as RJSFSchema;
    schema = {
      ...schema,
      required: ["provider", "baseURL", "match"],
      properties: {
        ...schema.properties,
        provider: {
          ...provider,
          enum: provider.enum?.filter((value) =>
            ["OpenAI", "Ollama", "Anthropic", "Gemini"].includes(String(value)),
          ),
        },
      },
    };
    const match = schema.properties?.match as RJSFSchema;
    schema.properties = { ...schema.properties, match: { ...match, required: ["model"] } };
  } else {
    const mcp = pick(schema.properties?.mcp as RJSFSchema, ["targets"]);
    const targets = mcp.properties?.targets as RJSFSchema;
    const target = pick(targets.items as RJSFSchema, ["static"]);
    target.required = ["static"];
    target.properties = {
      ...target.properties,
      static: pick(target.properties?.static as RJSFSchema, ["host", "port", "path", "protocol"]),
    };
    const staticSchema = target.properties.static as RJSFSchema;
    staticSchema.required = ["host", "port"];
    mcp.properties = { targets: { ...targets, minItems: 1, maxItems: 1, items: target } };
    schema.properties = { mcp };
  }
  return localizedSchema(schema, t);
}

export function endpoint(connection: Connection): string {
  const spec = object(native(connection).spec);
  if (connection.kind === ConnectionKind.MODEL) return String(spec.baseURL ?? "");
  const targets = object(spec.mcp).targets;
  return Array.isArray(targets)
    ? targets
        .map((target) => {
          const value = object(object(target).static);
          return `${value.host ?? ""}:${value.port ?? ""}${value.path ?? "/mcp"}`;
        })
        .join(", ")
    : "";
}
