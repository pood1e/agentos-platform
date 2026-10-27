import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPack } from "../server/console/pack.js";
import { toolServerLabel, toolText } from "../src/features/shared/tool-label.js";
import i18n from "../src/i18n/index.js";
import enAutomation from "../src/i18n/locales/automation.en.json";
import zhAutomation from "../src/i18n/locales/automation.zh-CN.json";
import en from "../src/i18n/locales/en.json";
import enManagement from "../src/i18n/locales/management.en.json";
import zhManagement from "../src/i18n/locales/management.zh-CN.json";
import enTools from "../src/i18n/locales/tools.en.json";
import zhTools from "../src/i18n/locales/tools.zh-CN.json";
import zh from "../src/i18n/locales/zh-CN.json";
import { applyPackLocales } from "../src/lib/pack.js";

function flatten(value: object, prefix = ""): Map<string, string> {
  return new Map(
    Object.entries(value).flatMap(([key, item]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof item === "string" ? [[path, item] as const] : [...flatten(item, path)];
    }),
  );
}
afterEach(async () => {
  await i18n.changeLanguage("zh");
});

describe("localized user interface", () => {
  it("keeps semantic keys and interpolation variables aligned across locale files", () => {
    const english = flatten({
        app: en,
        tools: enTools,
        management: enManagement,
        automation: enAutomation,
      }),
      chinese = flatten({
        app: zh,
        tools: zhTools,
        management: zhManagement,
        automation: zhAutomation,
      });
    const normalize = (key: string) => key.replace(/_(one|other)$/, "");
    expect(new Set([...english.keys()].map(normalize))).toEqual(new Set(chinese.keys()));
    for (const [key, value] of english) {
      expect(value.trim()).not.toBe("");
      expect([...value.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort()).toEqual(
        [...(chinese.get(normalize(key)) ?? "").matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort(),
      );
    }
  });
  it("keeps the example pack's locales aligned across languages", () => {
    const { locales } = loadPack(fileURLToPath(new URL("fixtures/pack/", import.meta.url)));
    const keys = (language: string) =>
      new Set(
        [...flatten(locales[language] ?? {}).keys()].map((key) => key.replace(/_(one|other)$/, "")),
      );
    expect(keys("en")).toEqual(keys("zh"));
  });
  it("uses localized names and descriptions without changing native tool identifiers", async () => {
    expect(toolText("k8s_get_resources")).toMatchObject({ name: "查询资源列表" });
    expect(toolText("mcp__cluster__k8s_get_resources").name).toBe("查询资源列表");
    expect(toolText("env-real_kubernetes_resources_list").name).toBe(
      "env-real_kubernetes_resources_list",
    );
    applyPackLocales(loadPack(fileURLToPath(new URL("fixtures/pack/", import.meta.url))));
    expect(toolText("env-real_kubernetes_resources_list").name).toBe("查询资源列表");
    expect(toolText("mcp__env-sim_jumpserver_ops_jobs_create").name).toBe("创建运维作业");
    expect(toolText("env-sim-zammad_get_ticket").name).toBe("查看工单");
    expect(toolText("env-real-zammad_get_ticket_history").name).toBe("查看工单历史");
    expect(toolText("env-real-keycloak_keycloak_identity_get").name).toBe("查询当前身份");
    expect(toolText("env-sim-keycloak_keycloak_client_service_account_get").name).toBe(
      "查看服务账号",
    );
    expect(toolText("env-sim-keycloak_keycloak_user_role_assign").name).toBe("授予环境角色");
    expect(toolText("functions.k8s_apply_manifest").name).toBe("应用资源变更");
    expect(toolText("grafana.query_loki").name).toBe("查询日志");
    expect(toolServerLabel("agentos/team-sessions")).toBe("团队协作");
    expect(toolText("unknown_internal_name")).toEqual({
      name: "unknown_internal_name",
      description: "",
    });
    await i18n.changeLanguage("en");
    expect(toolText("k8s_get_resources")).toMatchObject({ name: "List resources" });
    expect(toolText("env-sim_grafana_query_sql").name).toBe("Query SQL data");
    expect(toolText("env-sim-zammad_add_ticket_note").name).toBe("Add ticket note");
    expect(toolText("env-sim-keycloak_keycloak_identity_get").name).toBe("Get current identity");
    expect(toolText("k8s_apply_manifest").description).toMatch(/Create or update/);
    expect(toolText("unknown_internal_name", "Provider supplied purpose")).toEqual({
      name: "unknown_internal_name",
      description: "Provider supplied purpose",
    });
  });
  it("uses standard plural rules", async () => {
    await i18n.changeLanguage("en-US");
    expect(i18n.t("configuration.skillCount", { count: 1 })).toBe("1 skill");
    expect(i18n.t("configuration.skillCount", { count: 2 })).toBe("2 skills");
  });
});
