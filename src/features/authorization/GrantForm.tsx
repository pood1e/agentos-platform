import { create } from "@bufbuild/protobuf";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, Plus } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AccessRoleDefinition,
  type AuthorizationResource,
  RoleBindingSchema,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { authorizationClient } from "../../lib/console.js";
import { Failure } from "../management/ResourcePage.js";

export function GrantForm({
  workspace,
  scope,
  roles,
  onChanged,
}: {
  workspace: string;
  scope: AuthorizationResource;
  roles: AccessRoleDefinition[];
  onChanged: () => Promise<unknown>;
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
    onSuccess: onChanged,
  });
  return (
    <form
      className="grid gap-3 rounded-xl border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        grant.mutate();
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t("authorization.subjectType")}
          <select
            className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
            disabled={grant.isPending}
            value={subjectKind}
            onChange={(event) => setSubjectKind(event.target.value)}
          >
            <option value="principal">{t("authorization.principal")}</option>
            <option value="group">{t("authorization.group")}</option>
          </select>
        </label>
        {subjectKind === "group" && (
          <label
            htmlFor={`${id}-issuer`}
            className="grid min-w-48 flex-1 gap-1 text-xs text-muted-foreground"
          >
            {t("authorization.issuer")}
            <Input
              id={`${id}-issuer`}
              type="url"
              required
              disabled={grant.isPending}
              value={issuer}
              onChange={(event) => setIssuer(event.target.value)}
            />
          </label>
        )}
        <label
          htmlFor={`${id}-subject`}
          className="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground"
        >
          {t(subjectKind === "principal" ? "authorization.principalId" : "authorization.groupId")}
          <Input
            id={`${id}-subject`}
            required
            disabled={grant.isPending}
            value={principal}
            onChange={(event) => setPrincipal(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t("authorization.role")}
          <select
            className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
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
        <Button type="submit" disabled={grant.isPending}>
          {grant.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
          {t("authorization.grant")}
        </Button>
      </div>
      <Failure error={grant.error} />
    </form>
  );
}
