import { BookOpen, Library, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import type { RoleDefinition, Skill } from "../../../gen/agentos/console/v1/role_pb.js";
import { useCapability } from "../../lib/access.js";
import { editRole, editSkill, newSkill, skillKinds, withKind } from "./role-draft.js";
import { SkillPicker } from "./SkillPicker.js";
import { SkillSourceFields } from "./SkillSourceFields.js";

export function RoleSkills({
  role,
  onChange,
}: {
  role: RoleDefinition;
  onChange: (role: RoleDefinition) => void;
}) {
  const { t } = useTranslation();
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const [picker, setPicker] = useState(false);
  const replace = (index: number, skill: Skill) =>
    onChange(editRole(role, (draft) => draft.skills.splice(index, 1, skill)));
  return (
    <section className="space-y-4" data-testid="role-skills">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {t("configuration.skillCount", { count: role.skills.length })}
        </span>
        {editable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={role.skills.length >= 50}
            onClick={() => setPicker(true)}
          >
            <Library />
            {t("management.fromCatalog")}
          </Button>
        )}
        {editable && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={role.skills.length >= 50}
            onClick={() => onChange(editRole(role, (draft) => draft.skills.push(newSkill())))}
          >
            <Plus />
            {t("configuration.addSkill")}
          </Button>
        )}
      </div>
      {!role.skills.length && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-muted-foreground">
          <BookOpen className="size-6" />
          <p className="text-sm">{t("configuration.noSkills")}</p>
        </div>
      )}
      {role.skills.map((skill, index) => (
        <fieldset
          // biome-ignore lint/suspicious/noArrayIndexKey: Entries are edited in place and never reordered.
          key={index}
          data-testid="role-skill"
          aria-label={skill.name || t("configuration.newSkill")}
          className="min-w-0 space-y-4 rounded-xl border p-4"
        >
          <div className="flex items-start gap-3">
            <Label className="min-w-0 flex-1 flex-col items-start gap-1.5 text-xs">
              {t("configuration.skillName")}
              <Input
                readOnly={!editable}
                value={skill.name}
                onChange={(event) =>
                  replace(
                    index,
                    editSkill(skill, (draft) => {
                      draft.name = event.target.value;
                    }),
                  )
                }
                placeholder={t("configuration.skillPlaceholders.name")}
              />
            </Label>
            {editable && (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="mt-5 text-muted-foreground"
                aria-label={t("configuration.removeSkill")}
                onClick={() => onChange(editRole(role, (draft) => draft.skills.splice(index, 1)))}
              >
                <Trash2 />
              </Button>
            )}
          </div>
          <Select
            disabled={!editable}
            value={skill.source.case ?? "oci"}
            onValueChange={(value) => {
              const kind = skillKinds.find((item) => item === value);
              if (kind) replace(index, withKind(skill, kind));
            }}
          >
            <SelectTrigger aria-label={t("configuration.skillSource")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {skillKinds.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`configuration.skillSources.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SkillSourceFields
            skill={skill}
            onChange={(next) => replace(index, next)}
            readOnly={!editable}
          />
        </fieldset>
      ))}
      {picker && (
        <SkillPicker
          selected={role.skills}
          onSelect={(skill) => onChange(editRole(role, (draft) => draft.skills.push(skill)))}
          onClose={() => setPicker(false)}
        />
      )}
    </section>
  );
}
