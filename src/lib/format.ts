import { toJson } from "@bufbuild/protobuf";
import { type Timestamp, timestampMs, type Value, ValueSchema } from "@bufbuild/protobuf/wkt";
import i18n, { tr } from "../i18n/index.js";

export const millis = (timestamp?: Timestamp) => (timestamp ? timestampMs(timestamp) : undefined);

export function duration(start?: number, end?: number): string {
  if (start === undefined || end === undefined || end < start) return "—";
  const seconds = (end - start) / 1000;
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`;
}

export function time(value?: number): string {
  return value === undefined
    ? tr("status.unreported")
    : new Date(value).toLocaleTimeString(i18n.resolvedLanguage === "en" ? "en-US" : "zh-CN", {
        hour12: false,
      });
}

/** JSON values, including JSON documents carried as text, formatted for reading. */
export function pretty(value?: Value): string | undefined {
  if (!value) return undefined;
  const json = toJson(ValueSchema, value);
  if (typeof json !== "string") return JSON.stringify(json, null, 2);
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}
