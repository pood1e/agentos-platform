import { Code } from "@connectrpc/connect";
import type { ToolBinding } from "../../gen/agentos/console/v1/role_pb.js";
import { ModelPurpose } from "../../gen/agentos/management/v1/management_pb.js";
import type { ToolServer } from "../../gen/kagent/api/v1/tools_pb.js";
import { toolServerName } from "../../shared/kagent-resources.js";
import { modelPurpose } from "../../shared/model-purpose.js";
import type { BindingView, ToolBindings } from "../governance/tool-bindings.js";
import { listNativeTemplates, listWorkspaceToolServers } from "../kagent/catalog.js";
import type { KagentClients } from "../kagent/clients.js";
import { isWorkflowTemplate, systemTemplates } from "../kagent/resources.js";
import type { ToolMetadata } from "../kagent/tool-metadata.js";
import { fail } from "../shared/errors.js";

export const nativeRead = { timeoutMs: 10_000 };

/** What a role may select: language models, instruction templates and model-visible tools. */
export function roleCatalog(
  clients: KagentClients,
  namespace: string,
  access: BindingView,
  metadata: ToolMetadata,
) {
  async function modelTools(
    binding: Pick<ToolBinding, "server" | "tools">,
    servers: ToolServer[],
    policy: ToolBindings,
  ) {
    const server = servers.find((item) => toolServerName(item) === binding.server);
    return server
      ? metadata.modelTools(policy.metadataServer(server, servers), binding.tools)
      : binding.tools;
  }

  async function load() {
    const [templates, servers, models] = await Promise.all([
      listNativeTemplates(clients, namespace, nativeRead),
      listWorkspaceToolServers(clients, namespace, nativeRead),
      clients.models.listModelConfigs({}, nativeRead),
    ]).catch((error: unknown) => {
      throw fail(Code.Unavailable, "configuration.unavailable", error);
    });
    const policy = await access();
    return {
      modelConfigs: models.modelConfigs.filter(
        (item) =>
          item.ref?.namespace === namespace &&
          modelPurpose(item.resource?.value) === ModelPurpose.LANGUAGE,
      ),
      templates: templates.filter(
        (item) =>
          !systemTemplates.has(item.ref?.name ?? "") &&
          !isWorkflowTemplate(item.resource?.value?.spec),
      ),
      servers: await metadata.modelServers(servers, (server) =>
        policy.catalogServer(server, servers),
      ),
    };
  }

  return { modelTools, load };
}
