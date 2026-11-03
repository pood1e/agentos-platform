import type { JsonValue } from "@bufbuild/protobuf";

const secretKeys = new Set([
  "secret",
  "password",
  "passwd",
  "token",
  "apikey",
  "privatekey",
  "passphrase",
  "authorization",
  "clientsecret",
  "secretkey",
  "community",
]);
const sensitive = (key: string) => secretKeys.has(key.replace(/[-_]/g, "").toLowerCase());

/** Masks credential fields and their repeated values in an observable JSON payload. */
export function redact(value: JsonValue): JsonValue {
  const secrets = new Set<string>();
  function collect(node: JsonValue) {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object")
      for (const [key, item] of Object.entries(node)) {
        if (sensitive(key) && typeof item === "string" && item.length >= 4) secrets.add(item);
        collect(item);
      }
  }
  function mask(node: JsonValue): JsonValue {
    if (Array.isArray(node)) return node.map(mask);
    if (node && typeof node === "object")
      return Object.fromEntries(
        Object.entries(node).map(([key, item]) => [
          key,
          sensitive(key) ? "[REDACTED]" : mask(item),
        ]),
      );
    if (typeof node === "string")
      for (const secret of secrets) node = node.replaceAll(secret, "[REDACTED]");
    return node;
  }
  collect(value);
  return mask(value);
}
