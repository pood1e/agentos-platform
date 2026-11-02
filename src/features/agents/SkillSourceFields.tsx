import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GitSource, S3Source, Skill } from "../../../gen/agentos/console/v1/role_pb.js";
import { editSkill } from "./role-draft.js";

interface Field {
  key: string;
  get: (skill: Skill) => string;
  set: (skill: Skill, value: string) => void;
}

const git = (key: keyof Omit<GitSource, "$typeName" | "$unknown">, label: string): Field => ({
  key: label,
  get: (skill) => (skill.source.case === "git" ? skill.source.value[key] : ""),
  set: (skill, value) => {
    if (skill.source.case === "git") skill.source.value[key] = value;
  },
});

const bucket = (key: keyof Omit<S3Source, "$typeName" | "$unknown">, label: string): Field => ({
  key: label,
  get: (skill) => (skill.source.case === "bucket" ? skill.source.value[key] : ""),
  set: (skill, value) => {
    if (skill.source.case === "bucket") skill.source.value[key] = value;
  },
});

const fields: Record<string, Field[]> = {
  oci: [
    {
      key: "image",
      get: (skill) => (skill.source.case === "oci" ? skill.source.value : ""),
      set: (skill, value) => {
        skill.source = { case: "oci", value };
      },
    },
  ],
  git: [git("url", "repository"), git("commit", "commit")],
  bucket: [
    bucket("endpoint", "endpoint"),
    bucket("bucket", "bucket"),
    bucket("key", "objectKey"),
    bucket("versionId", "version"),
    bucket("region", "region"),
  ],
};

const path: Field = {
  key: "path",
  get: (skill) => skill.path,
  set: (skill, value) => {
    skill.path = value;
  },
};

export function SkillSourceFields({
  skill,
  onChange,
  readOnly = false,
}: {
  skill: Skill;
  onChange: (skill: Skill) => void;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-3">
      {[...(fields[skill.source.case ?? "oci"] ?? []), path].map((field) => (
        <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`${id}-${field.key}`} className="text-xs">
            {t(`configuration.skillFields.${field.key}`)}
          </Label>
          <Input
            id={`${id}-${field.key}`}
            readOnly={readOnly}
            value={field.get(skill)}
            placeholder={t(`configuration.skillPlaceholders.${field.key}`)}
            onChange={(event) =>
              onChange(editSkill(skill, (draft) => field.set(draft, event.target.value)))
            }
            className="min-w-0 font-mono text-xs"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={field.key === "path" ? 1024 : undefined}
          />
        </div>
      ))}
    </div>
  );
}
