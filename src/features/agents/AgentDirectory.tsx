import { create } from "@bufbuild/protobuf";
import { Search, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import type { AgentSummary, AgentTools } from "../../../gen/agentos/console/v1/agent_pb.js";
import type { RoleDefinition } from "../../../gen/agentos/console/v1/role_pb.js";
import {
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { useAccess, useCapability } from "../../lib/access.js";
import { useAgentAccess } from "../../lib/authorization.js";
import { authorizationHref } from "../authorization/resource-location.js";
import { Avatar } from "../shared/Avatar.js";
import { agentDescription, agentName, roleLabel } from "../shared/agents.js";
import { posture } from "../status/activity.js";
import { Status } from "../status/Status.js";
import { toolCount } from "./role-draft.js";

export function AgentDirectory({
  agents,
  roles: definitions,
  tools,
  loading,
  onConfigure,
}: {
  agents: AgentSummary[];
  roles: RoleDefinition[];
  tools: AgentTools[];
  loading: boolean;
  onConfigure: (role: RoleDefinition, trigger: HTMLButtonElement, agentId: string) => void;
}) {
  const { t } = useTranslation();
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const workspace = useAccess().data?.workspace?.namespace ?? "";
  const names = agents
    .filter((agent) => agent.id.startsWith(`${workspace}/`))
    .map((agent) => agent.id.slice(workspace.length + 1));
  const accessible = useAgentAccess(names).data ?? [];
  const [search, setSearch] = useState("");
  const [templateFilter, setTemplateFilter] = useState("*");
  const templates = new Map<string, number>();
  for (const agent of agents) {
    const key = (agent.template?.name ?? "") || "?";
    templates.set(key, (templates.get(key) ?? 0) + 1);
  }
  const selectedTemplate = templates.has(templateFilter) ? templateFilter : "*";
  const query = search.trim().toLowerCase();
  const visible = agents.filter(
    (agent) =>
      (selectedTemplate === "*" || ((agent.template?.name ?? "") || "?") === selectedTemplate) &&
      `${agentName(agent)} ${agent.id} ${agentDescription(agent)} ${roleLabel(agent.template?.name ?? "")}`
        .toLowerCase()
        .includes(query),
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input
            aria-label={t("team.searchLabel")}
            placeholder={t("team.searchPlaceholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="bg-card pl-9"
          />
        </div>
        <Select value={selectedTemplate} onValueChange={setTemplateFilter}>
          <SelectTrigger aria-label={t("team.filterTemplate")} className="w-40 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="*">{t("team.allTemplates")}</SelectItem>
            {[...templates].map(([key, count]) => (
              <SelectItem key={key} value={key}>
                {roleLabel(key === "?" ? "" : key)} · {count}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span data-testid="team-count" className="text-xs text-muted-foreground tabular-nums">
          {t("team.memberCount", {
            visible: visible.length,
            total: agents.length,
            roles: templates.size,
          })}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-4">
        {loading &&
          !agents.length &&
          [0, 1, 2].map((key) => <Skeleton key={key} className="h-56" />)}
        {visible.map((agent) => {
          const definition = definitions.find((item) => item.name === (agent.template?.name ?? ""));
          const builtinCatalog = tools.find(
            (item) => `${item.agent?.namespace}/${item.agent?.name}` === agent.id,
          )?.builtinCatalog;
          return (
            <Card
              key={agent.id}
              data-testid="team-card"
              data-agent={agent.id}
              data-template={agent.template?.name ?? ""}
              className="gap-0 overflow-hidden py-0 shadow-none"
            >
              <CardContent className="flex flex-1 flex-col gap-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="min-w-0 truncate font-semibold" title={agentName(agent)}>
                    {agentName(agent)}
                  </h2>
                  <Status state={agent.state} />
                </div>
                <div className="flex flex-1 items-center gap-4">
                  <div className="flex h-28 w-24 shrink-0 items-end justify-center rounded-lg bg-gradient-to-b from-sky-50/70 to-muted/40 dark:from-sky-950/40 dark:to-muted/30">
                    <Avatar
                      role={agent.template?.name ?? ""}
                      state={posture(agent.state)}
                      animated
                      className="h-28 w-24"
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    {agent.name && (
                      <Badge
                        variant="secondary"
                        className="max-w-24 shrink-0"
                        title={roleLabel(agent.template?.name ?? "")}
                      >
                        <span className="truncate">{roleLabel(agent.template?.name ?? "")}</span>
                      </Badge>
                    )}
                    <p className="text-xs leading-5 text-muted-foreground">
                      {agentDescription(agent, definition?.description)}
                    </p>
                    <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <div className="flex gap-1.5">
                        <dt>{t("team.activeTasks")}</dt>
                        <dd className="font-medium text-foreground tabular-nums">
                          {agent.activeTasks}
                        </dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt>{t("tool.calls")}</dt>
                        <dd className="font-medium text-foreground tabular-nums">
                          {agent.toolCalls}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>
                {agent.unavailableMessage && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="truncate rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
                        {t(`team.reasons.${agent.unavailableReason}`, {
                          defaultValue: agent.unavailableMessage,
                        })}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm break-words">
                      {agent.unavailableMessage}
                    </TooltipContent>
                  </Tooltip>
                )}
                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <span className="text-xs text-muted-foreground">
                    {t(builtinCatalog ? "configuration.toolCount" : "configuration.mcpToolCount", {
                      count:
                        (definition ? toolCount(definition) : 0) +
                        (builtinCatalog?.tools.length ?? 0),
                    })}
                  </span>
                  <div className="flex items-center gap-2">
                    {accessible.includes(agent.id.slice(workspace.length + 1)) && (
                      <Button asChild variant="ghost" size="sm">
                        <Link
                          to={authorizationHref(
                            create(AuthorizationResourceSchema, {
                              resource: {
                                case: "kubernetes",
                                value: {
                                  kind: AuthorizationScopeKind.AGENT,
                                  ref: {
                                    namespace: workspace,
                                    name: agent.id.slice(workspace.length + 1),
                                  },
                                },
                              },
                            }),
                          )}
                        >
                          <ShieldCheck />
                          {t("authorization.title")}
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!definition}
                      onClick={(event) => {
                        if (definition) onConfigure(definition, event.currentTarget, agent.id);
                      }}
                    >
                      {t(editable ? "configuration.configure" : "management.view")}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {!loading && !visible.length && (
        <p className="py-10 text-center text-sm text-muted-foreground">{t("team.noMembers")}</p>
      )}
    </div>
  );
}
