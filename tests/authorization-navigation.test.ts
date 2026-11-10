import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../gen/kagent/api/v1/authorization_pb.js";
import {
  authorizationHref,
  resourceFromSearch,
  resourceSearch,
} from "../src/features/authorization/resource-location.js";

const workspace = "team";
const session = "73383ee6-c3b3-4f2a-a926-920d936e3a7a";

const kubernetesKinds = {
  agent: AuthorizationScopeKind.AGENT,
  template: AuthorizationScopeKind.AGENT_TEMPLATE,
  harness: AuthorizationScopeKind.HARNESS,
  model: AuthorizationScopeKind.MODEL_CONNECTION,
  mcp: AuthorizationScopeKind.MCP_SERVER,
};

function resource(caseName: keyof typeof kubernetesKinds | "session" | "task" | "mcp-tool") {
  switch (caseName) {
    case "agent":
    case "template":
    case "harness":
    case "model":
    case "mcp":
      return create(AuthorizationResourceSchema, {
        resource: {
          case: "kubernetes",
          value: {
            kind: kubernetesKinds[caseName],
            ref: { namespace: workspace, name: "assistant.v2" },
          },
        },
      });
    case "mcp-tool":
      return create(AuthorizationResourceSchema, {
        resource: {
          case: "mcpTool",
          value: {
            server: {
              kind: AuthorizationScopeKind.MCP_SERVER,
              ref: { namespace: workspace, name: "tools.v2" },
            },
            name: "Search/Docs & status?+#工具 ",
          },
        },
      });
    case "session":
      return create(AuthorizationResourceSchema, {
        resource: { case: "sessionId", value: session },
      });
    case "task":
      return create(AuthorizationResourceSchema, {
        resource: { case: "task", value: { sessionId: session, taskId: "task/a" } },
      });
  }
}

describe("authorization resource navigation", () => {
  it.each(["agent", "template", "session", "task", "harness", "model", "mcp", "mcp-tool"] as const)(
    "round-trips %s URLs within the active workspace",
    (kind) => {
      const scope = resource(kind);
      expect(resourceFromSearch(workspace, resourceSearch(scope))).toEqual(scope);
      expect(authorizationHref(scope)).toContain("/authorization?type=");
    },
  );

  it("defaults malformed or incomplete targets to the active workspace", () => {
    for (const search of [
      "type=agent&name=other/ns",
      "type=session&session=not-a-uuid",
      `type=task&session=${session}`,
      "type=unknown&name=assistant",
      "type=mcp-tool&name=tools",
      `type=mcp-tool&name=tools&tool=${"x".repeat(129)}`,
      "type=model&name=bad..name",
    ]) {
      expect(resourceFromSearch(workspace, new URLSearchParams(search))).toEqual(
        create(AuthorizationResourceSchema, {
          resource: { case: "workspace", value: { namespace: workspace } },
        }),
      );
    }
  });

  it("uses the active workspace rather than URL-supplied namespaces", () => {
    const search = resourceSearch(resource("mcp-tool"));
    search.set("namespace", "forged");
    const target = resourceFromSearch("other-team", search);
    expect(target.resource.case).toBe("mcpTool");
    if (target.resource.case === "mcpTool")
      expect(target.resource.value.server?.ref?.namespace).toBe("other-team");
  });

  it("keeps Unicode tool identities intact at the native code-point limit", () => {
    const search = new URLSearchParams({ type: "mcp-tool", name: "tools", tool: "🔧".repeat(128) });
    expect(resourceFromSearch(workspace, search).resource.case).toBe("mcpTool");
    search.set("tool", "🔧".repeat(129));
    expect(resourceFromSearch(workspace, search).resource.case).toBe("workspace");
  });
});
