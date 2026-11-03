import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { AgentTemplateSchema } from "../../gen/kagent/api/v1/agent_templates_pb.js";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { object, text } from "../../shared/json.js";
import type { KagentClients } from "../kagent/clients.js";
import { roleDefinition } from "../kagent/role-template.js";

export function agentRoles(clients: KagentClients) {
  return async (session: Session) => {
    const { agent } = await clients.agents.getAgent({ ref: session.agent }, { timeoutMs: 5_000 });
    if (!agent) throw new ConnectError("Execution Agent is unavailable", Code.PermissionDenied);
    const source = object(object(agent.resource?.value?.spec).template);
    if (source.inline !== undefined) {
      const template = create(AgentTemplateSchema, {
        ref: agent.ref,
        resource: {
          value: { metadata: object(agent.resource?.value?.metadata), spec: object(source.inline) },
        },
      });
      return roleDefinition(template);
    }
    const reference = object(source.ref);
    const { agentTemplate } = await clients.templates.getAgentTemplate(
      {
        ref: { namespace: session.agent?.namespace, name: text(reference.name) },
      },
      { timeoutMs: 5_000 },
    );
    if (!agentTemplate)
      throw new ConnectError("Execution template is unavailable", Code.PermissionDenied);
    return roleDefinition(agentTemplate);
  };
}
