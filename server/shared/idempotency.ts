import { createHash } from "node:crypto";

/** Stable UUIDs let native A2A and Session APIs own retry deduplication. */
export function messageIdentity(...scope: string[]): string {
  const hash = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
