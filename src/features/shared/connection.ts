import {
  type Connection,
  ConnectionKind,
} from "../../../gen/agentos/management/v1/management_pb.js";
import { object } from "../../../shared/json.js";
import { displayNameAnnotation } from "../../../shared/kagent-resources.js";
import { toolServerLabel } from "./tool-label.js";

export const native = (connection: Connection) => connection.resource?.value ?? {};
export const metadata = (connection: Connection) => object(native(connection).metadata);
export const connectionName = (connection: Connection) => String(metadata(connection).name ?? "");
export const connectionLabel = (connection: Connection) =>
  String(
    object(metadata(connection).annotations)[displayNameAnnotation] ??
      toolServerLabel(connectionName(connection)),
  );
export const connectionProject = (connection: Connection) =>
  String(object(metadata(connection).labels)["agentos.dev/project"] ?? connectionName(connection));
export const connectionEnvironment = (connection: Connection) =>
  String(object(metadata(connection).labels)["agentos.dev/environment"] ?? "");

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
