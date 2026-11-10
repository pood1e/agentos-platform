import { create } from "@bufbuild/protobuf";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AccessRole,
  type AuthorizationResource,
  AuthorizationResourceSchema,
  RoleBindingSchema,
  type SubjectReference,
  SubjectReferenceSchema,
} from "../gen/kagent/api/v1/authorization_pb.js";
import { RoleBindingsTable } from "../src/features/authorization/RoleBindingsTable.js";
import { groupRoleBindings } from "../src/features/authorization/role-bindings.js";
import i18n from "../src/i18n/index.js";

const workspace = create(AuthorizationResourceSchema, {
  resource: { case: "workspace", value: { namespace: "team", uid: "workspace-uid" } },
});
const alice = create(SubjectReferenceSchema, {
  subject: { case: "principalId", value: "alice" },
});

function binding(
  role: AccessRole,
  subject: SubjectReference = alice,
  scope: AuthorizationResource = workspace,
) {
  return create(RoleBindingSchema, { subject, role, scope });
}

describe("account role tags", () => {
  it("combines roles across loaded pages and retains exact bindings for revocation", () => {
    const admin = binding(AccessRole.ACCESS_ADMIN);
    const member = binding(AccessRole.WORKSPACE_MEMBER);
    const editor = binding(AccessRole.DEFINITION_EDITOR);
    const firstPage = [admin, member];
    const nextPage = [editor, member];
    const groups = groupRoleBindings([...firstPage, ...nextPage]);
    expect(groups).toHaveLength(1);
    expect(groups[0].subject).toBe(alice);
    expect(groups[0].bindings).toEqual([member, editor, admin]);
    expect(groups[0].bindings[0]).toBe(member);
    expect(groups[0].bindings[2]).toBe(admin);
    expect(firstPage).toEqual([admin, member]);
  });

  it("keeps principals, group issuers and resource UIDs separate", () => {
    const group = (issuer: string) =>
      create(SubjectReferenceSchema, {
        subject: { case: "group", value: { issuer, id: "alice" } },
      });
    const rebuilt = create(AuthorizationResourceSchema, {
      resource: { case: "workspace", value: { namespace: "team", uid: "new-workspace-uid" } },
    });
    const session = create(AuthorizationResourceSchema, {
      resource: { case: "sessionId", value: "session" },
    });
    const groups = groupRoleBindings([
      binding(AccessRole.WORKSPACE_MEMBER),
      binding(AccessRole.WORKSPACE_MEMBER, group("https://issuer.one")),
      binding(AccessRole.WORKSPACE_MEMBER, group("https://issuer.two")),
      binding(AccessRole.WORKSPACE_MEMBER, alice, rebuilt),
      binding(AccessRole.EXECUTION_READER, alice, session),
    ]);
    expect(groups).toHaveLength(5);
    expect(new Set(groups.map((value) => value.key)).size).toBe(5);
  });

  it("renders one account row with multiple roles and individual revoke controls", async () => {
    await i18n.changeLanguage("en");
    const html = renderToStaticMarkup(
      createElement(RoleBindingsTable, {
        groups: groupRoleBindings([
          binding(AccessRole.WORKSPACE_MEMBER),
          binding(AccessRole.ACCESS_ADMIN),
        ]),
        current: "alice",
        editableRoles: [
          AccessRole.WORKSPACE_MEMBER,
          AccessRole.DEFINITION_READER,
          AccessRole.ACCESS_ADMIN,
        ],
        onAddRole: () => {},
        onRevoke: () => {},
      }),
    );
    expect(html.split("<tbody")[1].match(/<tr /g)).toHaveLength(1);
    expect(html).toContain("My account");
    expect(html).toContain("Workspace member");
    expect(html).toContain("Access administrator");
    expect(html).toContain('aria-label="Revoke Workspace member from alice"');
    expect(html).toContain('aria-label="Revoke Access administrator from alice"');
    expect(html).toContain("Add role");
    expect(html).toContain("View and manage resource grants.");
  });

  it("limits sharing controls to the execution-reader role", async () => {
    await i18n.changeLanguage("en");
    const html = renderToStaticMarkup(
      createElement(RoleBindingsTable, {
        groups: groupRoleBindings([
          binding(AccessRole.EXECUTION_READER),
          binding(AccessRole.ACCESS_ADMIN),
        ]),
        current: "alice",
        editableRoles: [AccessRole.EXECUTION_READER],
        onAddRole: () => {},
        onRevoke: () => {},
      }),
    );
    expect(html).toContain('aria-label="Revoke Execution reader from alice"');
    expect(html).not.toContain('aria-label="Revoke Access administrator from alice"');
    expect(html).not.toContain("Add role");
  });

  it("keeps read-only tags free of mutation controls", async () => {
    await i18n.changeLanguage("zh-CN");
    const html = renderToStaticMarkup(
      createElement(RoleBindingsTable, {
        groups: groupRoleBindings([
          binding(AccessRole.WORKSPACE_MEMBER),
          binding(AccessRole.ACCESS_ADMIN),
        ]),
        current: "alice",
        editableRoles: [],
        onAddRole: () => {},
        onRevoke: () => {},
      }),
    );
    expect(html).toContain("工作空间成员");
    expect(html).toContain("授权管理员");
    expect(html).not.toContain("<button");
  });
});
