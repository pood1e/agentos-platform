import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { object, text } from "../read-model/decode/messages.js";
import type { ResourceKind, ResourceStore } from "./resources.js";
export interface GatewayConfig {
  name: string;
  url: string;
  mcpUrl: string;
  namespace: string;
  secret: string;
}
export const meta = (value: JsonObject) => object(value.metadata);
export const ownerFor = (value: JsonObject) => [
  {
    apiVersion: text(value.apiVersion),
    kind: text(value.kind),
    name: text(meta(value).name),
    uid: text(meta(value).uid),
  },
];
export const resource = (value: JsonObject) => ({
  apiVersion: text(value.apiVersion),
  kind: text(value.kind),
  value,
});

export async function optional(store: ResourceStore, kind: ResourceKind, name: string) {
  try {
    return await store.get(kind, name);
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
    throw error;
  }
}
