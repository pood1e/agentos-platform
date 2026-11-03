import type { JsonObject, JsonValue } from "@bufbuild/protobuf";
import { ConnectionKind } from "../../gen/agentos/management/v1/management_pb.js";
import { object, text } from "../../shared/json.js";
import { actorTokenHeader } from "../kagent/context.js";
import { invalid } from "../shared/errors.js";

const withRemoved = (current: JsonValue | undefined, ...names: string[]) => [
  ...new Set([...(Array.isArray(current) ? current : []), ...names]),
];

/** Models route through the platform Gateway; only Actors granted the model may call it. */
function modelSpec(spec: JsonObject, name: string, gatewayName: string): JsonObject {
  if (text(object(spec.match).model).includes("*"))
    throw invalid("management.concreteModelRequired");
  const policies = object(spec.policies);
  const headers = object(policies.headers);
  const request = object(headers.request);
  return {
    ...spec,
    parentRefs: [
      {
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
        name: gatewayName,
        sectionName: "http",
      },
    ],
    policies: {
      ...policies,
      authorization: {
        action: "Require",
        policy: {
          matchExpressions: [
            `!('${actorTokenHeader}' in request.headers) || extauthz.models.exists(m, m.name == ${JSON.stringify(name)})`,
          ],
        },
      },
      headers: {
        ...headers,
        request: { ...request, remove: withRemoved(request.remove, actorTokenHeader) },
      },
    },
  };
}

/** One upstream per connection; platform credentials never reach it and authorization is compiled. */
function mcpSpec(spec: JsonObject): JsonObject {
  const mcp = object(spec.mcp);
  const targets = mcp.targets;
  if (!Array.isArray(targets) || targets.length !== 1) throw invalid("management.singleMCP");
  const target = object(targets[0]);
  const backend = object(target.static);
  const backendPolicies = object(backend.policies);
  const policies = object(spec.policies);
  const { authorization: _compiled, ...mcpPolicies } = object(policies.mcp);
  const transformation = object(policies.transformation);
  const request = object(transformation.request);
  return {
    ...spec,
    mcp: {
      ...mcp,
      prefixMode: mcp.prefixMode ?? "Never",
      targets: Object.keys(backend).length
        ? [
            {
              ...target,
              static: {
                ...backend,
                policies: {
                  ...backendPolicies,
                  http: { requestTimeout: "10m", ...object(backendPolicies.http) },
                },
              },
            },
          ]
        : targets,
    },
    policies: {
      ...policies,
      mcp: mcpPolicies,
      transformation: {
        ...transformation,
        request: {
          ...request,
          remove: withRemoved(
            request.remove,
            actorTokenHeader,
            "cookie",
            "x-forwarded-access-token",
          ),
        },
      },
    },
  };
}

/** Enforces gateway rules on an edited spec regardless of what the editor submitted. */
export const connectionSpec = (
  kind: ConnectionKind,
  name: string,
  spec: JsonObject,
  gatewayName: string,
) => (kind === ConnectionKind.MODEL ? modelSpec(spec, name, gatewayName) : mcpSpec(spec));
