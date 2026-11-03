import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, LockKeyhole, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AccessProfile } from "../../../gen/agentos/console/v1/access_pb.js";
import {
  AccessRole,
  type AuthorizationResource,
  Permission,
  type RoleBinding,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { useAccess } from "../../lib/access.js";
import { authorizationScopeKind, useResourceAccess } from "../../lib/authorization.js";
import { authorizationClient } from "../../lib/console.js";
import { Failure } from "../management/ResourcePage.js";
import { ConfirmDelete } from "../shared/ConfirmDelete.js";
import { subjectName } from "./BindingSubject.js";
import { GrantForm } from "./GrantForm.js";
import { RoleBindingsTable } from "./RoleBindingsTable.js";
import { resourceFromSearch, resourceSearch } from "./resource-location.js";
import { groupRoleBindings, type RoleBindingGroup } from "./role-bindings.js";
import { ScopeSelector } from "./ScopeSelector.js";

function resourceName(resource: AuthorizationResource, workspace: string) {
  switch (resource.resource.case) {
    case "workspace":
      return workspace;
    case "kubernetes":
      return resource.resource.value.ref?.name ?? "";
    case "sessionId":
      return resource.resource.value;
    case "task":
      return resource.resource.value.taskId;
    case "mcpTool":
      return `${resource.resource.value.server?.ref?.name ?? ""} / ${resource.resource.value.name}`;
    default:
      return "";
  }
}

function WorkspaceAuthorization({
  profile,
  selected,
  selectedKey,
  onSelect,
}: {
  profile: AccessProfile;
  selected: AuthorizationResource;
  selectedKey: string;
  onSelect: (resource: AuthorizationResource) => void;
}) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const { subject, workspace: reference } = profile;
  if (!reference) throw new Error("Access profile is missing workspace identity");
  const workspace = reference.namespace;
  const [adding, setAdding] = useState<{ recipient?: RoleBindingGroup }>();
  const [removing, setRemoving] = useState<{ binding: RoleBinding; requestId: string }>();
  const access = useResourceAccess(selected);
  const scope = access.data?.resource ?? selected;
  const allowed = access.isSuccess ? (access.data?.allowedActions ?? []) : [];
  const canRead = allowed.includes(Permission.ACCESS_READ);
  const canManage = allowed.includes(Permission.ACCESS_MANAGE);
  const canShare = allowed.includes(Permission.SESSION_SHARE);
  const kind = authorizationScopeKind(scope);
  const prefix = ["resource-authorization", subject, reference.uid];
  const bindings = useInfiniteQuery({
    queryKey: [...prefix, "bindings", scope],
    queryFn: ({ signal, pageParam }) =>
      authorizationClient.listRoleBindings(
        {
          workspace: reference,
          scope,
          page: { limit: 50, pageToken: pageParam },
        },
        { signal },
      ),
    initialPageParam: "",
    getNextPageParam: (page) => page.page?.nextPageToken || undefined,
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
  const changed = () => cache.invalidateQueries({ queryKey: prefix });
  const groups = groupRoleBindings(bindings.data?.pages.flatMap((page) => page.bindings) ?? []);
  const bindingCount = groups.reduce((count, group) => count + group.bindings.length, 0);
  const hasBindings = groups.length > 0;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-4"
      aria-label={t("authorization.title")}
    >
      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{t("authorization.title")}</h1>
          <Badge variant="outline">{workspace}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t("authorization.pageHint")}</p>
      </header>
      <ScopeSelector profile={profile} selected={selected} onSelect={onSelect} />
      <div
        className="rounded-xl border bg-card"
        aria-busy={access.isFetching || bindings.isFetching}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{t("authorization.subjectRoles")}</h2>
              <Badge variant="outline">{t("authorization.directBindings")}</Badge>
            </div>
            <p className="mt-1 break-all text-sm text-foreground">
              {t(`authorization.scopes.${kind}`)} · {resourceName(scope, workspace)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t("authorization.bindingHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("configuration.refresh")}
              disabled={access.isFetching || bindings.isFetching}
              onClick={() => void changed()}
            >
              <RefreshCw
                className={access.isFetching || bindings.isFetching ? "animate-spin" : ""}
              />
            </Button>
            {(canManage || canShare) && availableRoles.length > 0 && (
              <Button onClick={() => setAdding({})}>
                <Plus />
                {t("authorization.addBinding")}
              </Button>
            )}
          </div>
        </div>
        <div className="p-4">
          <Failure error={access.error ?? bindings.error ?? roles.error} />
          {(access.isPending || (canRead && bindings.isPending)) && (
            <div
              className="flex items-center gap-2 py-10 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin" />
              {t("management.loading")}
            </div>
          )}
          {access.isSuccess && !canRead && (
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
              <LockKeyhole className="size-5 shrink-0" />
              {t("authorization.denied")}
            </div>
          )}
          {canRead && bindings.isSuccess && !hasBindings && !bindings.hasNextPage && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <ShieldCheck className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">{t("authorization.emptyBindings")}</p>
              <p className="text-xs text-muted-foreground">
                {t("authorization.emptyBindingsHint")}
              </p>
            </div>
          )}
          {canRead && hasBindings && (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                {t(bindings.hasNextPage ? "authorization.loadedSummary" : "authorization.summary", {
                  subjects: groups.length,
                  bindings: bindingCount,
                })}
              </p>
              <RoleBindingsTable
                groups={groups}
                current={subject}
                editableRoles={availableRoles.map((role) => role.role)}
                onAddRole={(recipient) => setAdding({ recipient })}
                onRevoke={(binding) => setRemoving({ binding, requestId: crypto.randomUUID() })}
              />
            </>
          )}
          {canRead && bindings.hasNextPage && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t("authorization.moreBindingsHint")}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={bindings.isFetching}
                onClick={() => void bindings.fetchNextPage()}
              >
                {bindings.isFetchingNextPage && <LoaderCircle className="animate-spin" />}
                {t("authorization.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>
      {adding && availableRoles.length > 0 && (
        <GrantForm
          key={`${selectedKey}:${canManage}:${adding.recipient?.key ?? "new"}`}
          workspace={reference}
          subject={subject}
          scope={scope}
          roles={availableRoles}
          recipient={adding.recipient?.subject}
          assignedRoles={adding.recipient?.bindings.map((binding) => binding.role)}
          onChanged={changed}
          onClose={() => setAdding(undefined)}
        />
      )}
      {removing && (
        <ConfirmDelete
          title={t("authorization.revoke")}
          description={`${subjectName(removing.binding.subject)} · ${t(`authorization.roles.${removing.binding.role}`)}`}
          onClose={() => setRemoving(undefined)}
          onConfirm={async () => {
            await authorizationClient.revokeRole({
              workspace: reference,
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
  const { t } = useTranslation();
  const access = useAccess();
  const [search, setSearch] = useSearchParams();
  if (access.data) {
    const selected = resourceFromSearch(access.data.workspace?.namespace ?? "", search);
    const selectedKey = resourceSearch(selected).toString();
    return (
      <WorkspaceAuthorization
        key={`${access.data.subject}:${access.data.workspace?.uid}:${selectedKey}`}
        profile={access.data}
        selected={selected}
        selectedKey={selectedKey}
        onSelect={(resource) => setSearch(resourceSearch(resource))}
      />
    );
  }
  if (access.error) return <Failure error={access.error} />;
  return <p role="status">{t("management.loading")}</p>;
}
