import { create } from "@bufbuild/protobuf";
import type { ChangeEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RoleDefinition } from "../../../gen/agentos/console/v1/role_pb.js";
import { ResourceReferenceSchema } from "../../../gen/kagent/api/v1/common_pb.js";
import { agentName } from "../shared/agents.js";

/** Display name and identifier are fixed once a role exists. */
export function RoleIdentityFields({
  draft,
  existing,
  onDisplayName,
  onName,
}: {
  draft: RoleDefinition;
  existing: boolean;
  onDisplayName: ChangeEventHandler<HTMLInputElement>;
  onName: ChangeEventHandler<HTMLInputElement>;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid shrink-0 gap-4 p-4 sm:grid-cols-2 sm:px-6">
      <div className="space-y-2">
        <Label htmlFor="role-label">{t("configuration.name")}</Label>
        <Input
          id="role-label"
          form="role-form"
          required={!existing}
          maxLength={80}
          disabled={existing}
          value={draft.displayName}
          placeholder={
            existing
              ? agentName({
                  id: draft.name,
                  name: "",
                  template: create(ResourceReferenceSchema, { name: draft.name }),
                })
              : undefined
          }
          onChange={onDisplayName}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="role-id">{t("configuration.identifier")}</Label>
        <Input
          id="role-id"
          form="role-form"
          required
          pattern="[a-z]([a-z0-9\-]{0,61}[a-z0-9])?"
          maxLength={63}
          disabled={existing}
          value={draft.name}
          onChange={onName}
        />
      </div>
    </div>
  );
}
