import { cn } from "cn";
import { CircleCheck, Clock, Eye, Pencil, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
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
  type Connection,
  ConnectionKind,
  ModelPurpose,
} from "../../../gen/agentos/management/v1/management_pb.js";
import { useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { ConfirmDelete } from "../shared/ConfirmDelete.js";
import { roleLabel } from "../shared/engineers.js";
import { ToolIcon } from "../shared/ToolIcon.js";

import {
  connectionEnvironment,
  connectionLabel,
  connectionName,
  connectionProject,
  endpoint,
  metadata,
  native,
  object,
} from "./connection-schema.js";
import { ResourceSheet } from "./ResourceDialog.js";
import { ResourcePage, useManagementPage } from "./ResourcePage.js";

const ConnectionEditor = lazy(() =>
  import("./ConnectionEditor.js").then((module) => ({ default: module.ConnectionEditor })),
);

function accepted(connection: Connection) {
  const status = object(native(connection).status);
  const parents = Array.isArray(status.parents) ? status.parents : [];
  const conditions = [
    ...(Array.isArray(status.conditions) ? status.conditions.map(object) : []),
    ...parents.flatMap((parent) => {
      const value = object(parent).conditions;
      return Array.isArray(value) ? value.map(object) : [];
    }),
  ];
  return conditions.some(
    (condition) => condition.type === "Accepted" && condition.status === "True",
  );
}

export function ConnectionsPage({
  kind,
  purpose = ModelPurpose.UNSPECIFIED,
}: {
  kind: ConnectionKind;
  purpose?: ModelPurpose;
}) {
  const { t } = useTranslation();
  const editable = useCapability(
    kind === ConnectionKind.MODEL ? Capability.MODELS_MANAGE : Capability.MCP_MANAGE,
  );
  const isMCP = kind === ConnectionKind.MCP;
  const title = t(kind === ConnectionKind.MODEL ? "management.tabs.models" : "management.tabs.mcp");
  const list = useManagementPage(`connections:${kind}:${purpose}`, (request, signal) =>
    managementClient.listConnections({ ...request, kind, modelPurpose: purpose }, { signal }),
  );
  const [editing, setEditing] = useState<{ connection?: Connection }>();
  const [deleting, setDeleting] = useState<Connection>();
  return (
    <>
      <ResourcePage
        title={title}
        query={list.search}
        onQuery={list.onSearch}
        total={list.data?.totalSize ?? 0}
        pending={list.isPending}
        fetching={list.isFetching}
        error={list.error}
        onRefresh={() => void list.refetch()}
        onAdd={editable ? () => setEditing({}) : undefined}
        page={list.page}
        onPage={list.onPage}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("configuration.name")}</TableHead>
              {!isMCP && <TableHead>{t("management.fields.model")}</TableHead>}
              <TableHead>{t("management.endpoint")}</TableHead>
              {isMCP ? (
                <TableHead className="text-right">{t("management.toolCount")}</TableHead>
              ) : (
                <TableHead>{t("management.usedBy")}</TableHead>
              )}
              <TableHead>
                <span className="sr-only">{t("management.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.connections.map((connection) => {
              const name = connectionName(connection);
              const environment = connectionEnvironment(connection);
              const model = String(object(object(native(connection).spec).match).model ?? "");
              return (
                <TableRow key={name} data-testid="connection-row">
                  <TableCell>
                    <div className="flex items-center gap-3">
                      {isMCP && <ToolIcon name={connectionProject(connection)} />}
                      <div className={cn(isMCP && "flex items-center gap-2")}>
                        <Button
                          variant="link"
                          className="h-auto p-0 text-foreground"
                          onClick={() => setEditing({ connection })}
                        >
                          {isMCP ? connectionLabel(connection) : name}
                        </Button>
                        <div
                          className={cn(
                            "flex items-center gap-1.5 text-xs text-muted-foreground",
                            !isMCP && "mt-1",
                          )}
                        >
                          {accepted(connection) ? (
                            <CircleCheck
                              className="size-3 text-success"
                              aria-label={t("management.accepted")}
                            />
                          ) : (
                            <Clock className="size-3" aria-label={t("management.pending")} />
                          )}
                          {!isMCP && String(object(native(connection).spec).provider ?? "")}
                          {isMCP && environment && <Badge variant="outline">{environment}</Badge>}
                          {isMCP && connection.systemManaged && !environment && (
                            <Badge variant="secondary">{t("management.platformService")}</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  {!isMCP && (
                    <TableCell className="max-w-80 truncate font-mono text-xs" title={model}>
                      {model || "—"}
                    </TableCell>
                  )}
                  <TableCell>
                    <span
                      className="inline-block max-w-48 truncate align-middle text-xs text-muted-foreground sm:max-w-80"
                      title={endpoint(connection)}
                    >
                      {endpoint(connection)}
                    </span>
                  </TableCell>
                  {isMCP ? (
                    <TableCell className="text-right tabular-nums">
                      {connection.tools.length}
                    </TableCell>
                  ) : (
                    <TableCell className="max-w-60 truncate text-xs">
                      {connection.usedBy.map(roleLabel).join("、") || "—"}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(editable ? "management.edit" : "management.view")}
                      onClick={() => setEditing({ connection })}
                    >
                      {editable ? <Pencil /> : <Eye />}
                    </Button>
                    {editable && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("management.delete")}
                        disabled={connection.systemManaged || !!connection.usedBy.length}
                        onClick={() => setDeleting(connection)}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ResourcePage>
      <ResourceSheet
        title={t(
          !editable
            ? "management.view"
            : editing?.connection
              ? "management.editConnection"
              : "management.addConnection",
        )}
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        {editing && (
          <Suspense fallback={<p>{t("management.loading")}</p>}>
            <ConnectionEditor
              key={editing.connection ? connectionName(editing.connection) : "new"}
              kind={kind}
              purpose={purpose}
              connection={editing.connection}
              onSaved={() => {
                setEditing(undefined);
                void list.refetch();
              }}
            />
          </Suspense>
        )}
      </ResourceSheet>
      {editable && deleting && (
        <ConfirmDelete
          title={t("management.deleteNamed", { name: connectionName(deleting) })}
          description={t("management.deleteConnectionNotice")}
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            await managementClient.deleteConnection({
              kind,
              name: connectionName(deleting),
              resourceVersion: String(metadata(deleting).resourceVersion),
            });
            await list.refetch();
          }}
        />
      )}
    </>
  );
}
