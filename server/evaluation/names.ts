import { createHash } from "node:crypto";

export type Variant = "candidate" | "released";
export const variantPrefix = (id: string, variant: Variant) =>
  `e${id.replaceAll("-", "").slice(0, 16)}${variant[0]}-`;
export const variantName = (prefix: string, name: string) =>
  prefix.length + name.length <= 63
    ? `${prefix}${name}`
    : `${prefix}${name.slice(0, 54 - prefix.length)}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
