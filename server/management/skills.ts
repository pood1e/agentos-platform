import { clone, create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { SkillSchema } from "../../gen/agentos/console/v1/role_pb.js";
import {
  type SaveSkillRequest,
  SkillCatalogSchema,
} from "../../gen/agentos/management/v1/management_pb.js";
import { roleDefinition, skillSource } from "../console/role-template.js";
import type { KagentClients } from "../kagent/clients.js";
import { type PageRequest, pageOf } from "../read-model/page.js";
import { conflict, fail, invalid, notFound } from "../shared/errors.js";
import type { ResourceStore } from "./resources.js";

export function skillCommands(store: ResourceStore, clients: KagentClients, namespace: string) {
  async function read() {
    const state = await store.readCatalog();
    return { ...state, catalog: fromJsonString(SkillCatalogSchema, state.value) };
  }
  async function list(request: PageRequest) {
    const [{ catalog, version }, { agentTemplates }] = await Promise.all([
      read(),
      clients.templates.listAgentTemplates({ namespace }),
    ]);
    const roles = agentTemplates.map(roleDefinition);
    const query = request.query.trim().toLowerCase();
    const items = catalog.items
      .filter((item) => `${item.skill?.name} ${item.description}`.toLowerCase().includes(query))
      .sort((a, b) => (a.skill?.name ?? "").localeCompare(b.skill?.name ?? ""))
      .map((item) => ({
        ...item,
        resourceVersion: version,
        usedBy: roles
          .filter((role) => role.skills.some((skill) => skill.name === item.skill?.name))
          .map((role) => role.name),
      }));
    const page = pageOf(items, request, "management.skills", (item) => ({
      id: item.skill?.name ?? "",
      time: 0,
    }));
    return { skills: page.items, nextPageToken: page.nextPageToken, totalSize: page.totalSize };
  }
  async function save(request: SaveSkillRequest) {
    const item = request.item;
    if (!item?.skill?.name.trim()) throw invalid("management.invalid");
    await store.validate("templates", {
      apiVersion: "api.kagent.dev/v1alpha3",
      kind: "AgentTemplate",
      metadata: { generateName: "skill-validation-", namespace },
      spec: {
        modelConfig: { name: "default-model-config" },
        systemPrompt: "Validate skill source",
        skills: [{ name: item.skill.name, source: skillSource(item.skill) }],
      },
    });
    const { catalog, version } = await read();
    const index = catalog.items.findIndex(
      (candidate) => candidate.skill?.name === item.skill?.name,
    );
    if (request.create ? index >= 0 : index < 0) throw invalid("management.skillExists");
    if (!request.create && item.resourceVersion !== version)
      throw conflict("configuration.conflict");
    const stored = { skill: clone(SkillSchema, item.skill), description: item.description };
    const next = create(SkillCatalogSchema, {
      items:
        index < 0
          ? [...catalog.items, stored]
          : catalog.items.map((candidate, at) => (at === index ? stored : candidate)),
    });
    const value = toJsonString(SkillCatalogSchema, next);
    if (Buffer.byteLength(value) > 900_000)
      throw fail(Code.ResourceExhausted, "management.catalogFull");
    const newVersion = await store.writeCatalog(value, version);
    return { item: { ...stored, resourceVersion: newVersion } };
  }
  async function remove(name: string, expected: string) {
    const { catalog, version } = await read();
    if (version !== expected) throw conflict("configuration.conflict");
    if (!catalog.items.some((item) => item.skill?.name === name))
      throw notFound("management.notFound");
    catalog.items = catalog.items.filter((item) => item.skill?.name !== name);
    await store.writeCatalog(toJsonString(SkillCatalogSchema, catalog), version);
    return {};
  }
  return { list, save, remove };
}
