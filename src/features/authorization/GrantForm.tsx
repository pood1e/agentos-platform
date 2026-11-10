import { create } from "@bufbuild/protobuf";
import { useMutation } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";
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
  type SubjectReference,
  type WorkspaceAuthorizationReference,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { authorizationClient } from "../../lib/console.js";
import { Failure } from "../shared/ResourcePage.js";
import { BindingSubject } from "./BindingSubject.js";

export function GrantForm({
  workspace,
  subject,
  scope,
  roles,
  recipient,
  assignedRoles = [],
  onChanged,
  onClose,
}: {
  workspace: WorkspaceAuthorizationReference;
  subject: string;
  scope: AuthorizationResource;
  roles: AccessRoleDefinition[];
  recipient?: SubjectReference;
  assignedRoles?: AccessRole[];
  onChanged: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [subjectKind, setSubjectKind] = useState("principal");
  const [principal, setPrincipal] = useState("");
  const [issuer, setIssuer] = useState("");
  const [role, setRole] = useState(
    roles.find((value) => !assignedRoles.includes(value.role))?.role ?? AccessRole.UNSPECIFIED,
  );
  const intent = useRef<{ key: string; id: string } | undefined>(undefined);
  const grant = useMutation({
    mutationFn: async () => {
      const binding = create(RoleBindingSchema, {
        scope,
        role,
        subject: recipient ?? {
          subject:
            subjectKind === "principal"
              ? { case: "principalId", value: principal.trim() }
              : { case: "group", value: { issuer: issuer.trim(), id: principal.trim() } },
        },
      });
      const key = JSON.stringify(binding);
      if (intent.current?.key !== key) intent.current = { key, id: crypto.randomUUID() };
      await authorizationClient.grantRole({
        workspace,
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
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            {t(recipient ? "authorization.addRole" : "authorization.addBinding")}
          </DialogTitle>
          <DialogDescription>
            {t(recipient ? "authorization.addRoleHint" : "authorization.addBindingHint")}
          </DialogDescription>
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
            {recipient ? (
              <BindingSubject value={recipient} current={subject} />
            ) : (
              <>
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
                  <label
                    htmlFor={`${id}-issuer`}
                    className="grid gap-1 text-xs text-muted-foreground"
                  >
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
                <label
                  htmlFor={`${id}-subject`}
                  className="grid gap-1 text-xs text-muted-foreground"
                >
                  {t(
                    subjectKind === "principal"
                      ? "authorization.principalId"
                      : "authorization.groupId",
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
              </>
            )}
            {(scope.resource.case !== "workspace" ||
              (role !== AccessRole.WORKSPACE_MEMBER &&
                !assignedRoles.includes(AccessRole.WORKSPACE_MEMBER))) && (
              <p className="text-xs text-muted-foreground">{t("authorization.membershipHint")}</p>
            )}
          </div>
          <fieldset className="grid gap-2 rounded-lg border p-3">
            <legend className="px-1 text-xs text-muted-foreground">
              {t("authorization.role")}
            </legend>
            <div className="flex flex-wrap gap-2">
              {roles.map((value) => (
                <label key={value.role} className="cursor-pointer">
                  <input
                    type="radio"
                    name={`${id}-role`}
                    className="peer sr-only"
                    value={value.role}
                    checked={role === value.role}
                    disabled={grant.isPending || assignedRoles.includes(value.role)}
                    onChange={() => setRole(value.role)}
                  />
                  <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium peer-checked:border-primary peer-checked:bg-primary/10 peer-checked:text-primary peer-focus-visible:outline-2 peer-focus-visible:outline-ring peer-disabled:cursor-default peer-disabled:opacity-50">
                    {(role === value.role || assignedRoles.includes(value.role)) && (
                      <Check className="size-3" />
                    )}
                    {t(`authorization.roles.${value.role}`)}
                    {assignedRoles.includes(value.role) && (
                      <span>{t("authorization.assigned")}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                role === AccessRole.UNSPECIFIED
                  ? "authorization.allRolesAssigned"
                  : `authorization.roleHelp.${role}`,
              )}
            </p>
          </fieldset>
          <Failure error={grant.error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={grant.isPending} onClick={onClose}>
              {t("management.cancel")}
            </Button>
            <Button type="submit" disabled={grant.isPending || role === AccessRole.UNSPECIFIED}>
              {grant.isPending && <LoaderCircle className="animate-spin" />}
              {t("authorization.grant")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
