import { create } from "@bufbuild/protobuf";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AccessProfile } from "../../../gen/agentos/console/v1/access_pb.js";
import {
  type AuthorizationResource,
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { authorizationScopeKind } from "../../lib/authorization.js";
import { consoleClient } from "../../lib/console.js";
import { agentName, roleLabel } from "../shared/agents.js";
import { resourceSearch } from "./resource-location.js";

function option(resource: AuthorizationResource, label: string) {
  return { value: resourceSearch(resource).toString(), label, resource };
}

export function useResourceOptions(
  profile: AccessProfile,
  kind: AuthorizationScopeKind,
  selected: AuthorizationResource,
) {
  const { t } = useTranslation();
  const { subject, entryAgent } = profile;
  const workspace = profile.workspace?.namespace ?? "";
  const workspaceUID = profile.workspace?.uid;
  const agents = useQuery({
    queryKey: ["authorization-catalog", subject, workspaceUID, "agents"],
    queryFn: ({ signal }) => consoleClient.listAgents({}, { signal }),
    enabled: kind === AuthorizationScopeKind.AGENT,
  });
  const templates = useQuery({
    queryKey: ["authorization-catalog", subject, workspaceUID, "templates"],
    queryFn: ({ signal }) => consoleClient.getConfiguration({}, { signal }),
    enabled: kind === AuthorizationScopeKind.AGENT_TEMPLATE,
  });
  const sessions = useQuery({
    queryKey: ["authorization-catalog", subject, workspaceUID, "sessions", entryAgent?.name],
    queryFn: ({ signal }) =>
      consoleClient.listConversations({ agent: entryAgent, pageSize: 100 }, { signal }),
    enabled: kind === AuthorizationScopeKind.SESSION && !!entryAgent?.name,
  });
  const tasks = useQuery({
    queryKey: ["authorization-catalog", subject, workspaceUID, "tasks"],
    queryFn: ({ signal }) => consoleClient.listTasks({ pageSize: 100 }, { signal }),
    enabled: kind === AuthorizationScopeKind.TASK,
  });
  const options: ReturnType<typeof option>[] = [];
  if (kind === AuthorizationScopeKind.AGENT)
    for (const agent of agents.data?.agents ?? []) {
      if (!agent.id.startsWith(`${workspace}/`)) continue;
      const name = agent.id.slice(workspace.length + 1);
      options.push(
        option(
          create(AuthorizationResourceSchema, {
            resource: {
              case: "kubernetes",
              value: { kind, ref: { namespace: workspace, name } },
            },
          }),
          agentName(agent) === name ? name : `${agentName(agent)} · ${name}`,
        ),
      );
    }
  if (kind === AuthorizationScopeKind.AGENT_TEMPLATE)
    for (const template of templates.data?.roles ?? [])
      options.push(
        option(
          create(AuthorizationResourceSchema, {
            resource: {
              case: "kubernetes",
              value: { kind, ref: { namespace: workspace, name: template.name } },
            },
          }),
          template.displayName
            ? `${template.displayName} · ${template.name}`
            : roleLabel(template.name),
        ),
      );
  if (kind === AuthorizationScopeKind.SESSION)
    for (const session of sessions.data?.conversations ?? [])
      options.push(
        option(
          create(AuthorizationResourceSchema, {
            resource: { case: "sessionId", value: session.contextId },
          }),
          `${session.title || t("chat.title")} · ${session.contextId.slice(0, 8)}`,
        ),
      );
  if (kind === AuthorizationScopeKind.TASK)
    for (const task of tasks.data?.tasks ?? []) {
      if (!task.contextId || !task.id) continue;
      options.push(
        option(
          create(AuthorizationResourceSchema, {
            resource: { case: "task", value: { sessionId: task.contextId, taskId: task.id } },
          }),
          `${task.title || task.prompt || task.id} · ${task.id.slice(0, 8)}`,
        ),
      );
    }
  const selectedValue = resourceSearch(selected).toString();
  if (
    kind !== AuthorizationScopeKind.WORKSPACE &&
    authorizationScopeKind(selected) === kind &&
    !options.some((item) => item.value === selectedValue)
  )
    options.unshift(option(selected, t("authorization.currentResource")));
  const active =
    kind === AuthorizationScopeKind.AGENT
      ? agents
      : kind === AuthorizationScopeKind.AGENT_TEMPLATE
        ? templates
        : kind === AuthorizationScopeKind.SESSION && entryAgent?.name
          ? sessions
          : kind === AuthorizationScopeKind.TASK
            ? tasks
            : undefined;
  return { options, error: active?.error, loading: active?.isPending ?? false };
}
