import { create } from "@bufbuild/protobuf";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AccessProfile } from "../../../gen/agentos/console/v1/access_pb.js";
import {
  type AuthorizationResource,
  AuthorizationResourceSchema,
  AuthorizationScopeKind,
} from "../../../gen/kagent/api/v1/authorization_pb.js";
import { authorizationScopeKind } from "../../lib/authorization.js";
import { Failure } from "../management/ResourcePage.js";
import { resourceSearch } from "./resource-location.js";
import { useResourceOptions } from "./useResourceOptions.js";

const kinds = [
  AuthorizationScopeKind.WORKSPACE,
  AuthorizationScopeKind.AGENT,
  AuthorizationScopeKind.AGENT_TEMPLATE,
  AuthorizationScopeKind.SESSION,
  AuthorizationScopeKind.TASK,
];

export function ScopeSelector({
  profile,
  selected,
  onSelect,
}: {
  profile: AccessProfile;
  selected: AuthorizationResource;
  onSelect: (scope: AuthorizationResource) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const workspace = profile.workspace?.namespace ?? "";
  const [kind, setKind] = useState(authorizationScopeKind(selected));
  const [choice, setChoice] = useState(resourceSearch(selected).toString());
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [taskId, setTaskId] = useState("");
  const { options, error, loading } = useResourceOptions(profile, kind, selected);

  return (
    <form
      className="space-y-3 rounded-xl border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind === AuthorizationScopeKind.WORKSPACE)
          return onSelect(
            create(AuthorizationResourceSchema, {
              resource: { case: "workspace", value: { namespace: workspace } },
            }),
          );
        if (!manual) {
          const selectedOption = options.find((item) => item.value === choice);
          if (selectedOption) onSelect(selectedOption.resource);
          return;
        }
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
      <div>
        <h2 className="text-sm font-semibold">{t("authorization.chooseResource")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("authorization.chooseResourceHint")}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-40 gap-1 text-xs text-muted-foreground">
          {t("authorization.scope")}
          <select
            className="h-9 rounded-lg border bg-background px-3 text-sm text-foreground"
            value={kind}
            onChange={(event) => {
              setKind(Number(event.target.value));
              setChoice("");
              setManual(false);
              setName("");
              setTaskId("");
            }}
          >
            {kinds.map((value) => (
              <option key={value} value={value}>
                {t(`authorization.scopes.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {kind !== AuthorizationScopeKind.WORKSPACE && !manual && (
          <label className="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground">
            {t("authorization.resource")}
            <select
              className="h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground"
              aria-label={t("authorization.resource")}
              value={choice}
              required
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="">
                {t(loading ? "management.loading" : "authorization.selectResource")}
              </option>
              {options.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind !== AuthorizationScopeKind.WORKSPACE && manual && (
          <>
            <label
              htmlFor={`${id}-name`}
              className="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground"
            >
              {t(
                kind === AuthorizationScopeKind.SESSION || kind === AuthorizationScopeKind.TASK
                  ? "authorization.sessionId"
                  : "configuration.name",
              )}
              <Input
                id={`${id}-name`}
                required
                maxLength={
                  kind === AuthorizationScopeKind.SESSION || kind === AuthorizationScopeKind.TASK
                    ? 36
                    : 63
                }
                pattern={
                  kind === AuthorizationScopeKind.SESSION || kind === AuthorizationScopeKind.TASK
                    ? "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                    : "[a-z0-9]([-a-z0-9]*[a-z0-9])?"
                }
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {kind === AuthorizationScopeKind.TASK && (
              <label
                htmlFor={`${id}-task`}
                className="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground"
              >
                {t("authorization.taskId")}
                <Input
                  id={`${id}-task`}
                  required
                  maxLength={256}
                  value={taskId}
                  onChange={(event) => setTaskId(event.target.value)}
                />
              </label>
            )}
          </>
        )}
        <Button
          type="submit"
          variant="outline"
          disabled={kind !== AuthorizationScopeKind.WORKSPACE && !manual && !choice}
        >
          {t("authorization.openScope")}
        </Button>
      </div>
      {kind !== AuthorizationScopeKind.WORKSPACE && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setManual((value) => !value)}
        >
          {t(manual ? "authorization.pickFromList" : "authorization.openById")}
        </button>
      )}
      {!manual &&
        kind !== AuthorizationScopeKind.WORKSPACE &&
        !loading &&
        !options.length &&
        !error && (
          <p className="text-xs text-muted-foreground">{t("authorization.noResourceOptions")}</p>
        )}
      <Failure error={error} />
    </form>
  );
}
