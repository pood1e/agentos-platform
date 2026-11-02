import { create } from "@bufbuild/protobuf";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  type AuthorizationResource,
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";

export function ScopeSelector({
  workspace,
  onSelect,
}: {
  workspace: string;
  onSelect: (scope: AuthorizationResource) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [kind, setKind] = useState(AuthorizationScopeKind.WORKSPACE);
  const [name, setName] = useState("");
  const [taskId, setTaskId] = useState("");
  const session = kind === AuthorizationScopeKind.SESSION || kind === AuthorizationScopeKind.TASK;
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === AuthorizationScopeKind.WORKSPACE)
          return onSelect(
            create(AuthorizationResourceSchema, {
              resource: { case: "workspace", value: { namespace: workspace } },
            }),
          );
        if (kind === AuthorizationScopeKind.SESSION)
          return onSelect(
            create(AuthorizationResourceSchema, {
              resource: { case: "sessionId", value: name.trim() },
            }),
          );
        if (kind === AuthorizationScopeKind.TASK)
          return onSelect(
            create(AuthorizationResourceSchema, {
              resource: { case: "task", value: { sessionId: name.trim(), taskId: taskId.trim() } },
            }),
          );
        onSelect(
          create(AuthorizationResourceSchema, {
            resource: {
              case: "kubernetes",
              value: { kind, ref: { namespace: workspace, name: name.trim() } },
            },
          }),
        );
      }}
    >
      <label className="grid gap-1 text-xs text-muted-foreground">
        {t("authorization.scope")}
        <select
          className="h-8 rounded-lg border bg-background px-2 text-sm text-foreground"
          value={kind}
          onChange={(event) => setKind(Number(event.target.value))}
        >
          {[
            AuthorizationScopeKind.WORKSPACE,
            AuthorizationScopeKind.AGENT,
            AuthorizationScopeKind.AGENT_TEMPLATE,
            AuthorizationScopeKind.SESSION,
            AuthorizationScopeKind.TASK,
          ].map((value) => (
            <option key={value} value={value}>
              {t(`authorization.scopes.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {kind !== AuthorizationScopeKind.WORKSPACE && (
        <label
          htmlFor={`${id}-name`}
          className="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground"
        >
          {t(session ? "authorization.sessionId" : "configuration.name")}
          <Input
            id={`${id}-name`}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      )}
      {kind === AuthorizationScopeKind.TASK && (
        <label
          htmlFor={`${id}-task`}
          className="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground"
        >
          {t("authorization.taskId")}
          <Input
            id={`${id}-task`}
            required
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
          />
        </label>
      )}
      <Button type="submit" variant="outline">
        {t("authorization.openScope")}
      </Button>
    </form>
  );
}
