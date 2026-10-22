import { clone } from "@bufbuild/protobuf";
import { useMutation } from "@tanstack/react-query";
import { Eye, Pencil, Trash2 } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import {
  type SkillItem,
  SkillItemSchema,
} from "../../../gen/agentos/management/v1/management_pb.js";
import { useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { editSkill, newSkill, skillKinds, withKind } from "../engineers/role-draft.js";
import { SkillSourceFields } from "../engineers/SkillSourceFields.js";
import { roleLabel } from "../shared/engineers.js";
import { ConfirmDelete, ResourceSheet, SaveButton } from "./ResourceDialog.js";
import { Failure, ResourcePage, useManagementPage } from "./ResourcePage.js";

function SkillEditor({ item, onSaved }: { item?: SkillItem; onSaved: () => void }) {
  const { t } = useTranslation();
  const editable = useCapability(Capability.SKILLS_MANAGE);
  const [skill, setSkill] = useState(() =>
    item?.skill ? (clone(SkillItemSchema, item).skill ?? newSkill()) : newSkill(),
  );
  const [description, setDescription] = useState(item?.description ?? "");
  const save = useMutation({
    mutationFn: () =>
      managementClient.saveSkill({
        item: { skill, description, resourceVersion: item?.resourceVersion },
        create: !item,
      }),
    onSuccess: onSaved,
  });
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (editable) save.mutate();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="skill-name">{t("configuration.skillName")}</Label>
        <Input
          id="skill-name"
          required
          disabled={!!item || !editable}
          value={skill.name}
          onChange={(event) =>
            setSkill(
              editSkill(skill, (next) => {
                next.name = event.target.value;
              }),
            )
          }
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="skill-description">{t("configuration.description")}</Label>
        <Input
          id="skill-description"
          maxLength={400}
          readOnly={!editable}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <Select
        disabled={!editable}
        value={skill.source.case ?? "oci"}
        onValueChange={(value) => {
          const kind = skillKinds.find((item) => item === value);
          if (kind) setSkill(withKind(skill, kind));
        }}
      >
        <SelectTrigger aria-label={t("configuration.skillSource")}>
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
      <SkillSourceFields skill={skill} onChange={setSkill} readOnly={!editable} />
      <Failure error={save.error} />
      {editable && <SaveButton pending={save.isPending} />}
    </form>
  );
}

export function SkillsPage() {
  const { t } = useTranslation();
  const editable = useCapability(Capability.SKILLS_MANAGE);
  const list = useManagementPage("skills", (request, signal) =>
    managementClient.listSkills(request, { signal }),
  );
  const [editing, setEditing] = useState<{ item?: SkillItem }>();
  const [deleting, setDeleting] = useState<SkillItem>();
  const title = t("management.tabs.skills");
  return (
    <>
      <ResourcePage
        title={title}
        query={list.search}
        onQuery={list.onSearch}
        total={list.data?.totalSize ?? 0}
        pending={list.isPending}
        fetching={list.isFetching}
        error={list.error}
        onRefresh={() => void list.refetch()}
        onAdd={editable ? () => setEditing({}) : undefined}
        page={list.page}
        onPage={list.onPage}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("configuration.skillName")}</TableHead>
              <TableHead>{t("configuration.skillSource")}</TableHead>
              <TableHead>{t("management.usedBy")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("management.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.skills.map((item) => (
              <TableRow key={item.skill?.name} data-testid="skill-row">
                <TableCell>
                  <Button
                    variant="link"
                    className="h-auto p-0 text-foreground"
                    onClick={() => setEditing({ item })}
                  >
                    {item.skill?.name}
                  </Button>
                  {item.description && (
                    <p className="mt-1 max-w-72 truncate text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {t(`configuration.skillSources.${item.skill?.source.case ?? "oci"}`)}
                </TableCell>
                <TableCell className="max-w-60 truncate text-xs">
                  {item.usedBy.map(roleLabel).join("、") || "—"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t(editable ? "management.edit" : "management.view")}
                    onClick={() => setEditing({ item })}
                  >
                    {editable ? <Pencil /> : <Eye />}
                  </Button>
                  {editable && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("management.delete")}
                      onClick={() => setDeleting(item)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ResourcePage>
      <ResourceSheet
        title={t(
          !editable
            ? "management.view"
            : editing?.item
              ? "management.editSkill"
              : "management.addSkill",
        )}
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined);
        }}
      >
        {editing && (
          <SkillEditor
            key={editing.item?.skill?.name ?? "new"}
            item={editing.item}
            onSaved={() => {
              setEditing(undefined);
              void list.refetch();
            }}
          />
        )}
      </ResourceSheet>
      {editable && deleting && (
        <ConfirmDelete
          title={t("management.deleteNamed", { name: deleting.skill?.name })}
          description={t("management.deleteSkillNotice")}
          onClose={() => setDeleting(undefined)}
          onConfirm={async () => {
            await managementClient.deleteSkill({
              name: deleting.skill?.name ?? "",
              resourceVersion: deleting.resourceVersion,
            });
            await list.refetch();
          }}
        />
      )}
    </>
  );
}
