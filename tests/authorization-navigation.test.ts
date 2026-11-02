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

function resource(caseName: "agent" | "template" | "session" | "task") {
  switch (caseName) {
    case "agent":
    case "template":
      return create(AuthorizationResourceSchema, {
        resource: {
          case: "kubernetes",
          value: {
            kind:
              caseName === "agent"
                ? AuthorizationScopeKind.AGENT
                : AuthorizationScopeKind.AGENT_TEMPLATE,
            ref: { namespace: workspace, name: "assistant" },
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
  it.each(["agent", "template", "session", "task"] as const)(
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
    ]) {
      expect(resourceFromSearch(workspace, new URLSearchParams(search))).toEqual(
        create(AuthorizationResourceSchema, {
          resource: { case: "workspace", value: { namespace: workspace } },
        }),
      );
    }
  });
});
