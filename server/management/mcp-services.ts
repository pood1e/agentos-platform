import { isDeepStrictEqual } from "node:util";
import { create, type JsonObject } from "@bufbuild/protobuf";
import { MCPCredentialBindingSchema } from "../../gen/agentos/management/v1/management_pb.js";
import { type ToolServer, ToolServerSchema } from "../../gen/kagent/api/v1alpha1/tools_pb.js";
import { object, text } from "../read-model/decode/messages.js";
import { meta } from "./native.js";
import type { ResourceStore } from "./resources.js";

export const credentialProfile = (value: JsonObject) =>
  Boolean(object(meta(value).labels)["agentos.dev/engineer"]);

export function serviceTargets(value: JsonObject) {
  const targets = object(object(value.spec).mcp).targets;
  return Array.isArray(targets) ? targets.map(object) : [];
}

export function serviceBindings(
  service: JsonObject,
  backends: JsonObject[],
  servers: ToolServer[],
  namespace: string,
) {
  const name = text(meta(service).name);
  const primary =
    servers.find((server) => server.ref === `${namespace}/${name}`) ??
    create(ToolServerSchema, { ref: `${namespace}/${name}` });
  const bindings = backends
    .filter(
      (backend) =>
        credentialProfile(backend) &&
        serviceTargets(backend).some((target) => target.name === name),
    )
    .map((backend) => {
      const server =
        servers.find((item) => item.ref === `${namespace}/${meta(backend).name}`) ??
        create(ToolServerSchema, { ref: `${namespace}/${meta(backend).name}` });
      return create(MCPCredentialBindingSchema, {
        engineer: text(object(meta(backend).labels)["agentos.dev/engineer"]),
        server: create(ToolServerSchema, {
          ...server,
          discoveredTools: server.discoveredTools.filter((tool) =>
            tool.name.startsWith(`${name}_`),
          ),
        }),
      });
    });
  if (primary)
    bindings.unshift(
      create(MCPCredentialBindingSchema, {
        engineer: "catalog",
        server: primary,
      }),
    );
  return bindings;
}

/** Service settings are shared; each credential profile retains its own authentication. */
export async function refreshCredentialProfiles(store: ResourceStore, service: JsonObject) {
  const name = text(meta(service).name);
  const source = serviceTargets(service)[0];
  if (!source) return;
  for (const profile of await store.list("mcps")) {
    if (!credentialProfile(profile)) continue;
    const targets = serviceTargets(profile);
    const target = targets.find((item) => item.name === name);
    if (!target) continue;
    const authentication = object(object(object(target.static).policies).auth);
    const configuration = object(source.static);
    const configurationWithIdentity = {
      ...configuration,
      policies: {
        ...object(object(service.spec).policies),
        ...object(configuration.policies),
        auth: authentication,
      },
    };
    if (isDeepStrictEqual(target.static, configurationWithIdentity)) continue;
    target.static = configurationWithIdentity;
    await store.save(
      "mcps",
      {
        ...profile,
        spec: {
          ...object(profile.spec),
          mcp: { ...object(object(profile.spec).mcp), targets },
        },
      },
      false,
    );
  }
}
