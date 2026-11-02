import { create } from "@bufbuild/protobuf";
import {
  type AuthorizationResource,
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";

const resourceName = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function resourceFromSearch(workspace: string, search: URLSearchParams) {
  const type = search.get("type");
  const name = search.get("name") ?? "";
  const session = search.get("session") ?? "";
  const task = search.get("task") ?? "";
  if ((type === "agent" || type === "template") && name.length <= 63 && resourceName.test(name))
    return create(AuthorizationResourceSchema, {
      resource: {
        case: "kubernetes",
        value: {
          kind:
            type === "agent" ? AuthorizationScopeKind.AGENT : AuthorizationScopeKind.AGENT_TEMPLATE,
          ref: { namespace: workspace, name },
        },
      },
    });
  if (type === "session" && uuid.test(session))
    return create(AuthorizationResourceSchema, { resource: { case: "sessionId", value: session } });
  if (type === "task" && uuid.test(session) && task.length > 0 && task.length <= 256)
    return create(AuthorizationResourceSchema, {
      resource: { case: "task", value: { sessionId: session, taskId: task } },
    });
  return create(AuthorizationResourceSchema, {
    resource: { case: "workspace", value: { namespace: workspace } },
  });
}

export function resourceSearch(resource: AuthorizationResource) {
  const search = new URLSearchParams();
  switch (resource.resource.case) {
    case "kubernetes":
      search.set(
        "type",
        resource.resource.value.kind === AuthorizationScopeKind.AGENT ? "agent" : "template",
      );
      search.set("name", resource.resource.value.ref?.name ?? "");
      break;
    case "sessionId":
      search.set("type", "session");
      search.set("session", resource.resource.value);
      break;
    case "task":
      search.set("type", "task");
      search.set("session", resource.resource.value.sessionId);
      search.set("task", resource.resource.value.taskId);
      break;
  }
  return search;
}

export function authorizationHref(resource: AuthorizationResource) {
  const search = resourceSearch(resource).toString();
  return search ? `/authorization?${search}` : "/authorization";
}
