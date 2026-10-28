import type { JsonObject } from "@bufbuild/protobuf";
import { actorTokenHeader } from "../authorization/actor.js";
import type { GatewayConfig } from "./native.js";

export function mcpGuardrails(gateway: GatewayConfig, service: string): JsonObject {
  return {
    processors: [
      {
        methods: { "*": "Full" },
        remote: {
          backendRef: { name: gateway.name.replace(/-gateway$/, "-dataplane"), port: 9090 },
          failureMode: "FailClosed",
          allowedRequestHeaders: [actorTokenHeader, "authorization"],
          metadata: {
            workspace: JSON.stringify(gateway.namespace),
            platformService: JSON.stringify(service),
            toolName: "has(mcp.tool) ? mcp.tool.name : ''",
            runtimeIdentity: `'${actorTokenHeader}' in request.headers ? request.headers['${actorTokenHeader}'] : ''`,
          },
        },
      },
    ],
  };
}
