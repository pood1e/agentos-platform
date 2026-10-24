import { Code, ConnectError } from "@connectrpc/connect";
import type { Session } from "../../gen/kagent/api/v1/sessions_pb.js";
import { roleDefinition } from "../console/role-template.js";
import type { KagentClients } from "../kagent/clients.js";
import { agentInfo } from "../read-model/agents.js";
import { object, text } from "../read-model/decode/messages.js";

export function agentRoles(clients: KagentClients) {
  return async (session: Session) => {
    const { agent } = await clients.agents.getAgent({ ref: session.agent }, { timeoutMs: 5_000 });
    if (!agent) throw new ConnectError("Execution Agent is unavailable", Code.PermissionDenied);
    const reference = object(object(object(agent.resource?.value?.spec).template).ref);
    const { agentTemplate } = await clients.templates.getAgentTemplate(
      {
        ref: { namespace: session.agent?.namespace, name: text(reference.name) },
      },
      { timeoutMs: 5_000 },
    );
    if (!agentTemplate)
      throw new ConnectError("Execution template is unavailable", Code.PermissionDenied);
    return { engineer: agentInfo(agent).role, role: roleDefinition(agentTemplate), agent };
  };
}
