import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import type { Engineer } from "../../../gen/agentos/console/v1/engineer_pb.js";
import { Avatar } from "../shared/Avatar.js";
import { engineerName } from "../shared/engineers.js";
import { active, awaiting, labelKey, posture } from "../status/activity.js";
import { StatusIcon } from "../status/Status.js";
import type { Chat } from "./use-chat.js";

export const ConversationAgents = createContext<readonly Engineer[]>([]);

export function useConversationAgent(id: string) {
  return (
    useContext(ConversationAgents).find((agent) => agent.id === id) ?? {
      id,
      name: id.split("/").at(-1) ?? id,
      role: "",
    }
  );
}

export function WorkingAgents({ chat }: { chat: Chat }) {
  const { t } = useTranslation();
  const runs = (chat.conversation?.runs ?? []).filter(
    (run) => active(run.state) || awaiting(run.state),
  );
  const agents = [...new Map(runs.map((run) => [run.agentId, run])).values()];
  if (!agents.length) return null;
  return (
    <div
      data-testid="chat-working-agents"
      role="status"
      aria-label={t("chat.workingAgents")}
      className="mx-auto flex w-full max-w-3xl shrink-0 flex-wrap items-center gap-2 px-3 pb-2 sm:px-4"
    >
      <span className="mr-1 text-xs text-muted-foreground">{t("chat.workingAgents")}</span>
      {agents.map((run) => {
        const agent = chat.conversation?.participants.find((member) => member.id === run.agentId);
        const name = agent ? engineerName(agent) : run.agentId.split("/").at(-1);
        return (
          <span
            key={run.agentId}
            data-testid="chat-working-agent"
            data-agent-id={run.agentId}
            title={`${name} · ${t(labelKey(run.state))}`}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-full border bg-muted/30 py-0.5 pr-2.5 pl-1 text-xs"
          >
            <Avatar role={agent?.role} state={posture(run.state)} animated className="h-7 w-6" />
            <span className="max-w-40 truncate">{name}</span>
            <StatusIcon state={run.state} />
          </span>
        );
      })}
    </div>
  );
}
