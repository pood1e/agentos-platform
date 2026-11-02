import { create } from "@bufbuild/protobuf";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AccessProfile } from "../../../gen/agentos/console/v1/access_pb.js";
import {
  AccessRole,
  type AuthorizationResource,
  AuthorizationResourceSchema,
  Permission,
  type RoleBinding,
  type SubjectReference,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { useAccess } from "../../lib/access.js";
import { authorizationScopeKind, useResourceAccess } from "../../lib/authorization.js";
import { authorizationClient } from "../../lib/console.js";
import { Failure } from "../management/ResourcePage.js";
import { ConfirmDelete } from "../shared/ConfirmDelete.js";
import { GrantForm } from "./GrantForm.js";
import { ScopeSelector } from "./ScopeSelector.js";

function subjectName(subject: SubjectReference | undefined) {
  if (subject?.subject.case === "group")
    return `${subject.subject.value.id} · ${subject.subject.value.issuer}`;
  return subject?.subject.case === "principalId" ? subject.subject.value : "";
}

function WorkspaceAuthorization({ profile }: { profile: AccessProfile }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const { subject, workspace } = profile;
  const [selected, setSelected] = useState(() =>
    create(AuthorizationResourceSchema, {
      resource: { case: "workspace", value: { namespace: workspace } },
    }),
  );
  const access = useResourceAccess(selected);
  const scope = access.data?.resource ?? selected;
  const allowed = access.isSuccess ? (access.data?.allowedActions ?? []) : [];
  const canRead = allowed.includes(Permission.ACCESS_READ);
  const canManage = allowed.includes(Permission.ACCESS_MANAGE);
  const canShare = allowed.includes(Permission.SESSION_SHARE);
  const kind = authorizationScopeKind(scope);
  const [tokens, setTokens] = useState([""]);
  const [removing, setRemoving] = useState<{ binding: RoleBinding; requestId: string }>();
  const prefix = ["resource-authorization", subject, workspace];
  const bindings = useQuery({
    queryKey: [...prefix, "bindings", scope, tokens.at(-1)],
    queryFn: ({ signal }) =>
      authorizationClient.listRoleBindings(
        {
          workspace: { namespace: workspace },
          scope,
          page: { limit: 50, pageToken: tokens.at(-1) },
        },
        { signal },
      ),
    enabled: canRead,
    retry: false,
  });
  const roles = useQuery({
    queryKey: [...prefix, "roles"],
    queryFn: ({ signal }) => authorizationClient.listAccessRoles({}, { signal }),
    enabled: canManage || canShare,
  });
  const availableRoles =
    roles.data?.roles.filter(
      (role) =>
        role.scopeKinds.includes(kind) && (canManage || role.role === AccessRole.EXECUTION_READER),
    ) ?? [];
  const changed = () => {
    setTokens([""]);
    return cache.invalidateQueries({ queryKey: prefix });
  };
  const select = (resource: AuthorizationResource) => {
    setSelected(resource);
    setTokens([""]);
    setRemoving(undefined);
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4" aria-label={t("authorization.title")}>
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("authorization.title")}</h1>
          <p className="text-xs text-muted-foreground">
            {workspace} · {t("authorization.bindingHint")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("configuration.refresh")}
          disabled={access.isFetching || bindings.isFetching}
          onClick={() => void changed()}
        >
          <RefreshCw />
        </Button>
      </header>
      <ScopeSelector workspace={workspace} onSelect={select} />
      <Failure error={access.error ?? bindings.error ?? roles.error} />
      {access.isPending && (
        <p className="text-sm text-muted-foreground" role="status">
          {t("management.loading")}
        </p>
      )}
      {access.isSuccess && !canRead && (
        <p className="text-sm text-muted-foreground">{t("authorization.denied")}</p>
      )}
      {(canManage || canShare) && availableRoles.length > 0 && (
        <GrantForm
          key={`${JSON.stringify(scope)}:${canManage}`}
          workspace={workspace}
          scope={scope}
          roles={availableRoles}
          onChanged={changed}
        />
      )}
      {canRead && (
        <>
          <div
            className="min-h-0 flex-1 overflow-auto rounded-xl border bg-card"
            aria-busy={bindings.isFetching}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("authorization.subject")}</TableHead>
                  <TableHead>{t("authorization.role")}</TableHead>
                  <TableHead className="w-16">
                    <span className="sr-only">{t("authorization.revoke")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bindings.data?.bindings.map((binding) => (
                  <TableRow key={`${JSON.stringify(binding.subject)}:${binding.role}`}>
                    <TableCell className="break-all font-mono text-xs">
                      {subjectName(binding.subject)}
                    </TableCell>
                    <TableCell>{t(`authorization.roles.${binding.role}`)}</TableCell>
                    <TableCell>
                      {(canManage ||
                        (canShare && binding.role === AccessRole.EXECUTION_READER)) && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={t("authorization.revoke")}
                          onClick={() => setRemoving({ binding, requestId: crypto.randomUUID() })}
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {bindings.isSuccess && bindings.data.bindings.length === 0 && (
              <p className="p-10 text-center text-sm text-muted-foreground">
                {t("management.empty")}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={tokens.length < 2 || bindings.isFetching}
              onClick={() => setTokens((current) => current.slice(0, -1))}
            >
              {t("authorization.previous")}
            </Button>
            <span className="text-sm text-muted-foreground">{tokens.length}</span>
            <Button
              variant="outline"
              disabled={!bindings.data?.page?.nextPageToken || bindings.isFetching}
              onClick={() =>
                setTokens((current) => [...current, bindings.data?.page?.nextPageToken ?? ""])
              }
            >
              {t("authorization.next")}
            </Button>
          </div>
        </>
      )}
      {removing && (
        <ConfirmDelete
          title={t("authorization.revoke")}
          description={`${subjectName(removing.binding.subject)} · ${t(`authorization.roles.${removing.binding.role}`)}`}
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await authorizationClient.revokeRole({
              workspace: { namespace: workspace },
              requestId: removing.requestId,
              binding: removing.binding,
            });
            await changed();
          }}
        />
      )}
    </section>
  );
}

export function AuthorizationPage() {
  const access = useAccess();
  return access.data ? (
    <WorkspaceAuthorization
      key={`${access.data.subject}:${access.data.workspace}`}
      profile={access.data}
    />
  ) : (
    <Failure error={access.error} />
  );
}
