import { create } from "@bufbuild/protobuf";
import { useQuery } from "@tanstack/react-query";
import { GitBranch, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import {
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { useAccess, useCapability } from "../../lib/access.js";
import { useAgentAccess } from "../../lib/authorization.js";
import { managementClient } from "../../lib/console.js";
import { authorizationHref } from "../authorization/resource-location.js";
import { ResourcePage } from "../management/ResourcePage.js";

export function WorkflowsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const access = useAccess().data;
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const [search, setSearch] = useState("");
  const list = useQuery({
    queryKey: ["workflows", "list", access?.workspace?.uid, access?.subject],
    queryFn: () => managementClient.listWorkflows({}),
    refetchInterval: 10_000,
  });
  const accessible =
    useAgentAccess(
      (list.data?.agents ?? [])
        .filter(
          (agent) => agent.ref?.namespace === access?.workspace?.namespace && !!agent.ref?.name,
        )
        .map((agent) => agent.ref?.name ?? ""),
    ).data ?? [];
  const visible = (list.data?.agents ?? []).filter((agent) =>
    agent.ref?.name.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <ResourcePage
      title={t("workflow.title")}
      query={search}
      onQuery={setSearch}
      total={visible.length}
      pending={list.isPending}
      fetching={list.isFetching}
      error={list.error}
      onRefresh={() => void list.refetch()}
      onAdd={editable ? () => void navigate("/workflows/new") : undefined}
      page={0}
      onPage={() => {}}
      pagination={false}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("configuration.name")}</TableHead>
            <TableHead>{t("workflow.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((agent) => (
            <TableRow key={agent.ref?.name} data-testid="workflow-row">
              <TableCell>
                <div className="flex items-center gap-2">
                  <GitBranch className="size-4" />
                  <Link
                    className="font-medium hover:underline"
                    to={`/workflows/${encodeURIComponent(agent.ref?.name ?? "")}/edit`}
                  >
                    {agent.ref?.name}
                  </Link>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link to={`/workflows/${encodeURIComponent(agent.ref?.name ?? "")}/history`}>
                      {t("workflow.history")}
                    </Link>
                  </Button>
                  {accessible.includes(agent.ref?.name ?? "") && (
                    <Button asChild variant="ghost" size="sm">
                      <Link
                        to={authorizationHref(
                          create(AuthorizationResourceSchema, {
                            resource: {
                              case: "kubernetes",
                              value: {
                                kind: AuthorizationScopeKind.AGENT,
                                ref: {
                                  namespace: access?.workspace?.namespace ?? "",
                                  name: agent.ref?.name ?? "",
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
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ResourcePage>
  );
}
