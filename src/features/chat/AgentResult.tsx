import type { DataMessagePartComponent } from "@assistant-ui/react";
import { isMessage } from "@bufbuild/protobuf";
import { useTranslation } from "react-i18next";
import { TaskRunSchema } from "../../../gen/agentos/execution/v1/task_pb.js";
import { Avatar } from "../shared/Avatar.js";
import { engineerName } from "../shared/engineers.js";
import { Markdown } from "../shared/Markdown.js";
import { labelKey } from "../status/activity.js";
import { StatusIcon } from "../status/Status.js";
import { useConversationAgent } from "./AgentPresence.js";

export const AgentResult: DataMessagePartComponent = ({ data }) => {
  const { t } = useTranslation();
  const run = isMessage(data, TaskRunSchema) ? data : undefined;
  const agent = useConversationAgent(run?.agentId ?? "");
  if (!run) return null;
  return (
    <section
      data-testid="chat-agent-result"
      data-task-id={run.taskId}
      data-agent-id={run.agentId}
      aria-label={t("chat.agentResult", { name: engineerName(agent) })}
      className="my-4 min-w-0 rounded-lg border-l-2 bg-muted/25 px-4 py-3"
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Avatar role={agent.role} className="h-6 w-5" />
        <span>{engineerName(agent)}</span>
        <span title={t(labelKey(run.state))}>
          <StatusIcon state={run.state} />
        </span>
      </div>
      <Markdown>{run.output}</Markdown>
    </section>
  );
};
