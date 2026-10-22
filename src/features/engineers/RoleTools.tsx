import { Search, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import type { RoleDefinition } from "../../../gen/agentos/console/v1/role_pb.js";
import type { ToolRequirement } from "../../../gen/agentos/console/v1/tool_pb.js";
import type { DiscoveredTool, ToolServer } from "../../../gen/kagent/api/v1alpha1/tools_pb.js";
import { useCapability } from "../../lib/access.js";
import {
  connectionEnvironment,
  connectionLabel,
  connectionName,
  connectionProject,
} from "../management/connection-schema.js";
import { Failure } from "../management/ResourcePage.js";
import { ToolIcon } from "../shared/ToolIcon.js";
import { toolServerLabel, toolText } from "../shared/tool-label.js";
import { serverName, serviceServers, toolRequirements } from "./mcp-services.js";
import { hasTool, toggleTool } from "./role-draft.js";
import { useMCPServices } from "./use-mcp-services.js";

export function RoleTools({
  role,
  builtinTools,
  servers: toolServers,
  requirements,
  onChange,
}: {
  role: RoleDefinition;
  builtinTools: DiscoveredTool[];
  servers: ToolServer[];
  requirements?: ToolRequirement[];
  onChange: (role: RoleDefinition) => void;
}) {
  const { t } = useTranslation();
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string[]>();
  const catalog = useMCPServices();
  const services = catalog.data?.filter((service) => !service.systemManaged) ?? [];
  const bound = new Set(
    services.flatMap((service) => service.credentialBindings.map((binding) => binding.server?.ref)),
  );
  const access = toolRequirements(requirements);
  const sources = [
    ...services.flatMap((service) => {
      const profiles = serviceServers(role.name, service, !!connectionEnvironment(service));
      return profiles.length
        ? [
            {
              ref: connectionName(service),
              discoveredTools: profiles.flatMap((server) =>
                server.discoveredTools.map((tool) => ({
                  ...tool,
                  server: serverName(server),
                })),
              ),
              id: connectionName(service),
              label: connectionLabel(service),
              project: connectionProject(service),
              environment: connectionEnvironment(service),
            },
          ]
        : [];
    }),
    ...toolServers
      .filter((server) => !bound.has(server.ref))
      .map((server) => ({
        ...server,
        discoveredTools: server.discoveredTools.map((tool) => ({
          ...tool,
          server: serverName(server),
        })),
        id: server.ref,
        label: toolServerLabel(server.ref),
        project: server.ref,
        environment: "",
      })),
  ];
  const selectedServers = sources.filter((server) =>
    server.discoveredTools.some((tool) => hasTool(role, tool.server, tool.name)),
  );
  const defaultExpanded = (selectedServers.length ? selectedServers : sources.slice(0, 1)).map(
    (server) => server.id,
  );
  const query = search.trim().toLowerCase();
  const builtins = builtinTools
    .map((tool) => ({ ...tool, label: toolText(tool.name, tool.description) }))
    .filter((tool) =>
      `${tool.label.name} ${tool.label.description} ${tool.name}`.toLowerCase().includes(query),
    );
  const servers = sources.flatMap((server) => {
    const tools = server.discoveredTools
      .map((tool) => ({ ...tool, label: toolText(tool.name, tool.description) }))
      .filter((tool) =>
        `${tool.label.name} ${tool.label.description} ${tool.name} ${tool.description} ${server.label} ${server.environment}`
          .toLowerCase()
          .includes(query),
      );
    return tools.length ? [{ ...server, tools }] : [];
  });
  if (catalog.isPending)
    return <p className="text-sm text-muted-foreground">{t("management.loading")}</p>;
  if (catalog.error) return <Failure error={catalog.error} />;
  return (
    <section className="space-y-3">
      <Failure error={catalog.error} />
      <div className="relative">
        <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label={t("configuration.searchTools")}
          placeholder={t("configuration.searchTools")}
          className="pl-9"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <Accordion
        type="multiple"
        value={
          query
            ? ["builtin", ...servers.map((server) => server.id)]
            : (expanded ?? [...(builtinTools.length ? ["builtin"] : []), ...defaultExpanded])
        }
        onValueChange={setExpanded}
        className="rounded-lg border px-3"
      >
        {!!builtins.length && (
          <AccordionItem value="builtin" data-testid="builtin-tools">
            <AccordionTrigger className="gap-3 text-xs">
              <ToolIcon name="kagent" className="size-7" />
              <span className="min-w-0 flex-1 text-left">{t("configuration.builtinTools")}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {t("configuration.toolCount", { count: builtinTools.length })}
              </span>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              {builtins.map((tool) => (
                <div key={tool.name} data-tool-name={tool.name} className="flex items-start gap-3">
                  <ToolIcon name={tool.name} server="kagent" className="size-6" />
                  <div className="min-w-0 flex-1">
                    <span className="block text-xs leading-5">{tool.label.name}</span>
                    <code className="block text-[11px] text-muted-foreground">{tool.name}</code>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {tool.label.description}
                    </p>
                  </div>
                </div>
              ))}
            </AccordionContent>
          </AccordionItem>
        )}
        {servers.map((server) => {
          const selected = server.discoveredTools.filter((tool) =>
            hasTool(role, tool.server, tool.name),
          ).length;
          return (
            <AccordionItem key={server.id} value={server.id}>
              <AccordionTrigger className="gap-3 text-xs">
                <ToolIcon name={server.project} className="size-7" />
                <span className="min-w-0 flex-1 text-left">
                  {server.label}
                  {server.environment && (
                    <span className="ml-2 font-normal text-muted-foreground">
                      {server.environment}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
                  {t("configuration.selectedTools", {
                    selected,
                    total: server.discoveredTools.length,
                  })}
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {server.tools.map((tool) => {
                  const decision = access(tool.server, tool.name);

                  return (
                    <Label
                      key={tool.name}
                      data-tool-name={tool.name}
                      data-approval={String(decision)}
                      className="min-w-0 items-start gap-3"
                    >
                      <Checkbox
                        className="mt-1"
                        aria-label={tool.label.name}
                        disabled={!editable || decision === undefined}
                        checked={hasTool(role, tool.server, tool.name)}
                        onCheckedChange={(checked) =>
                          onChange(
                            toggleTool(
                              role,
                              decision === true,
                              tool.server,
                              tool.name,
                              checked === true,
                            ),
                          )
                        }
                      />
                      <ToolIcon name={tool.name} server={server.ref} className="size-6" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs leading-5">{tool.label.name}</span>
                        {tool.label.name !== tool.name && (
                          <code className="block break-all text-[11px] text-muted-foreground">
                            {tool.name}
                          </code>
                        )}
                        {tool.label.description && (
                          <span className="line-clamp-2 text-xs leading-5 font-normal text-muted-foreground">
                            {tool.label.description}
                          </span>
                        )}
                      </span>
                      {decision === true && (
                        <ShieldCheck
                          className="mt-1 size-3.5 shrink-0 text-info"
                          aria-label={t("configuration.approvalRequired")}
                        />
                      )}
                    </Label>
                  );
                })}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
      {!servers.length && !builtins.length && (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {t("configuration.noTools")}
        </p>
      )}
    </section>
  );
}
