import { create } from "@bufbuild/protobuf";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  AccessRole,
  type AccessRoleDefinition,
  type AuthorizationResource,
  RoleBindingSchema,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { authorizationClient } from "../../lib/console.js";
import { Failure } from "../management/ResourcePage.js";

export function GrantForm({
  workspace,
  subject,
  scope,
  roles,
  onChanged,
  onClose,
}: {
  workspace: string;
  subject: string;
  scope: AuthorizationResource;
  roles: AccessRoleDefinition[];
  onChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [subjectKind, setSubjectKind] = useState("principal");
  const [principal, setPrincipal] = useState("");
  const [issuer, setIssuer] = useState("");
  const [role, setRole] = useState(roles[0].role);
  const intent = useRef<{ key: string; id: string } | undefined>(undefined);
  const grant = useMutation({
    mutationFn: async () => {
      const binding = create(RoleBindingSchema, {
        scope,
        role,
        subject: {
          subject:
            subjectKind === "principal"
              ? { case: "principalId", value: principal.trim() }
              : { case: "group", value: { issuer: issuer.trim(), id: principal.trim() } },
        },
      });
      const key = JSON.stringify(binding);
      if (intent.current?.key !== key) intent.current = { key, id: crypto.randomUUID() };
      await authorizationClient.grantRole({
        workspace: { namespace: workspace },
        requestId: intent.current.id,
        binding,
      });
      intent.current = undefined;
    },
    onSuccess: async () => {
      await onChanged();
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !grant.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("authorization.addBinding")}</DialogTitle>
          <DialogDescription>{t("authorization.addBindingHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            grant.mutate();
          }}
        >
          <div className="grid gap-3 rounded-lg border p-3">
            <h3 className="text-sm font-medium">{t("authorization.subject")}</h3>
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t("authorization.subjectType")}
              <select
                className="h-9 rounded-lg border bg-background px-3 text-sm text-foreground"
                disabled={grant.isPending}
                value={subjectKind}
                onChange={(event) => {
                  setSubjectKind(event.target.value);
                  setPrincipal("");
                }}
              >
                <option value="principal">{t("authorization.principal")}</option>
                <option value="group">{t("authorization.group")}</option>
              </select>
            </label>
            {subjectKind === "group" && (
              <label htmlFor={`${id}-issuer`} className="grid gap-1 text-xs text-muted-foreground">
                {t("authorization.issuer")}
                <Input
                  id={`${id}-issuer`}
                  type="url"
                  pattern="https://[^?#]+"
                  maxLength={192}
                  required
                  disabled={grant.isPending}
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                />
              </label>
            )}
            <label htmlFor={`${id}-subject`} className="grid gap-1 text-xs text-muted-foreground">
              {t(
                subjectKind === "principal" ? "authorization.principalId" : "authorization.groupId",
              )}
              <Input
                id={`${id}-subject`}
                maxLength={subjectKind === "principal" ? 256 : 128}
                required
                disabled={grant.isPending}
                value={principal}
                onChange={(event) => setPrincipal(event.target.value)}
              />
            </label>
            {subjectKind === "principal" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={grant.isPending}
                onClick={() => setPrincipal(subject)}
              >
                {t("authorization.useMyAccount")}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              {t(
                subjectKind === "principal"
                  ? "authorization.principalHint"
                  : "authorization.groupHint",
              )}
            </p>
            {(scope.resource.case !== "workspace" || role !== AccessRole.WORKSPACE_MEMBER) && (
              <p className="text-xs text-muted-foreground">{t("authorization.membershipHint")}</p>
            )}
          </div>
          <div className="grid gap-2 rounded-lg border p-3">
            <label className="grid gap-1 text-xs text-muted-foreground">
              {t("authorization.role")}
              <select
                className="h-9 rounded-lg border bg-background px-3 text-sm text-foreground"
                disabled={grant.isPending}
                value={role}
                onChange={(event) => setRole(Number(event.target.value))}
              >
                {roles.map((value) => (
                  <option key={value.role} value={value.role}>
                    {t(`authorization.roles.${value.role}`)}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">{t(`authorization.roleHelp.${role}`)}</p>
          </div>
          <Failure error={grant.error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={grant.isPending} onClick={onClose}>
              {t("management.cancel")}
            </Button>
            <Button type="submit" disabled={grant.isPending}>
              {grant.isPending && <LoaderCircle className="animate-spin" />}
              {t("authorization.grant")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
