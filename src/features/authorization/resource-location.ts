import { create } from "@bufbuild/protobuf";
import {
  type AuthorizationResource,
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";

const resourceName = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const kubernetesTypes = new Map([
  ["agent", AuthorizationScopeKind.AGENT],
  ["template", AuthorizationScopeKind.AGENT_TEMPLATE],
  ["harness", AuthorizationScopeKind.HARNESS],
  ["model", AuthorizationScopeKind.MODEL_CONNECTION],
  ["mcp", AuthorizationScopeKind.MCP_SERVER],
]);

export function resourceFromSearch(workspace: string, search: URLSearchParams) {
  const type = search.get("type");
  const name = search.get("name") ?? "";
  const session = search.get("session") ?? "";
  const task = search.get("task") ?? "";
  const tool = search.get("tool") ?? "";
  const kind = kubernetesTypes.get(type ?? "");
  const validName = name.length <= 253 && resourceName.test(name);
  if (kind && validName)
    return create(AuthorizationResourceSchema, {
      resource: {
        case: "kubernetes",
        value: {
          kind,
          ref: { namespace: workspace, name },
        },
      },
    });
  if (type === "mcp-tool" && validName && tool.length > 0 && [...tool].length <= 128)
    return create(AuthorizationResourceSchema, {
      resource: {
        case: "mcpTool",
        value: {
          server: {
            kind: AuthorizationScopeKind.MCP_SERVER,
            ref: { namespace: workspace, name },
          },
          name: tool,
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
    case "kubernetes": {
      const { kind } = resource.resource.value;
      const type = [...kubernetesTypes].find(([, candidate]) => kind === candidate);
      if (type) {
        search.set("type", type[0]);
        search.set("name", resource.resource.value.ref?.name ?? "");
      }
      break;
    }
    case "mcpTool":
      search.set("type", "mcp-tool");
      search.set("name", resource.resource.value.server?.ref?.name ?? "");
      search.set("tool", resource.resource.value.name);
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
