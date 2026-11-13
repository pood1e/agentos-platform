import { create, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import {
  type ResourceReference,
  ResourceReferenceSchema,
} from "../../gen/kagent/api/v1/common_pb.js";
import { object, text } from "../../shared/json.js";
import { userOwned } from "../shared/kubernetes.js";

/** Platform Agents whose templates stay out of role and task directories. */
export const systemTemplates = new Set(["assistant"]);

export const isWorkflowTemplate = (spec: JsonValue | undefined) =>
  object(spec).workflowFrom !== undefined;

export const agentKey = (ref?: Pick<ResourceReference, "namespace" | "name">) =>
  ref ? `${ref.namespace}/${ref.name}` : "";

export function agentRef(id: string) {
  const [namespace = "", name = ""] = id.split("/");
  return create(ResourceReferenceSchema, { namespace, name });
}

export const meta = (value: JsonObject) => object(value.metadata);

/** Native envelope of a stored Kubernetes object. */
export const resource = (value: JsonObject) => ({
  apiVersion: text(value.apiVersion),
  kind: text(value.kind),
  value,
});

export const userResource = (value: JsonObject): JsonObject => ({
  ...value,
  metadata: userOwned(meta(value)),
});
