import { expect, it } from "vitest";
import { parseCatalog, requiresApproval } from "../shared/tool-catalog.js";

it("requires write approval for asset administration independently of device operations", () => {
  const catalog = parseCatalog(
    "jumpserver:\n  readOnly: [perms_users_assets_list]\n  managementReadOnly: [assets_hosts_list]\n  write: [ops_jobs_create]\n  management: [assets_hosts_create, accounts_accounts_create]",
    "{}",
  );
  const tools = catalog.projects.get("jumpserver");
  expect(tools?.get("assets_hosts_list")).toBe("read");
  expect(tools?.get("ops_jobs_create")).toBe("write");
  expect(tools?.get("assets_hosts_create")).toBe("write");
  expect(tools?.get("accounts_accounts_create")).toBe("write");
  expect(tools?.has("users_users_create")).toBe(false);
  expect(requiresApproval(catalog, "jumpserver", "ops_jobs_create")).toBe(true);
  expect(requiresApproval(catalog, "jumpserver", "assets_hosts_create")).toBe(true);
  expect(requiresApproval(catalog, "jumpserver", "accounts_accounts_create")).toBe(true);
});

it("uses an explicit approval set without granting read-only users write access", () => {
  const catalog = parseCatalog(
    "tickets:\n  readOnly: [get_ticket]\n  write: [create_ticket]\n  approval: []",
    "{}",
  );
  expect(catalog.projects.get("tickets")?.get("create_ticket")).toBe("write");
  expect(requiresApproval(catalog, "tickets", "create_ticket")).toBe(false);
  expect(requiresApproval(catalog, "tickets", "unknown_tool")).toBe(true);
});
