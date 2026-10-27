import { create, type JsonObject } from "@bufbuild/protobuf";
import { MCPCredentialBindingSchema } from "../../gen/agentos/management/v1/management_pb.js";
import { type ToolServer, ToolServerSchema } from "../../gen/kagent/api/v1/tools_pb.js";
import type { AccessPlan } from "../governance/access-plans.js";
import { serverTargets } from "../governance/bindings.js";
import { text } from "../read-model/decode/messages.js";
import { meta } from "./native.js";

export function compiledTargets(plans: JsonObject[]) {
  return serverTargets(plans as unknown as AccessPlan[]);
}

export function serviceBindings(
  service: JsonObject,
  plans: JsonObject[],
  servers: ToolServer[],
  namespace: string,
) {
  const name = text(meta(service).name);
  const targets = compiledTargets(plans);
  return [
    { server: name, engineer: "catalog" },
    ...[...targets.values()].filter((target) => target.service === name && target.engineer),
  ].map((target) =>
    create(MCPCredentialBindingSchema, {
      engineer: target.engineer,
      server:
        servers.find((server) => server.ref === `${namespace}/${target.server}`) ??
        create(ToolServerSchema, { ref: `${namespace}/${target.server}` }),
    }),
  );
}
