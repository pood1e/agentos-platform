import { clone } from "@bufbuild/protobuf";
import { useMutation, useQuery } from "@connectrpc/connect-query";
import { Blocks, BookOpen, LoaderCircle, NotebookPen, Play, Save, X } from "lucide-react";
import { type ChangeEvent, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import {
  ConsoleService,
  type GetConfigurationResponse,
} from "../../../gen/agentos/console/v1/console_service_pb.js";
import {
  type RoleDefinition,
  RoleDefinitionSchema,
} from "../../../gen/agentos/console/v1/role_pb.js";
import { useCapability } from "../../lib/access.js";
import { errorKey } from "../../lib/errors.js";
import { engineerName } from "../shared/engineers.js";
import { RoleBuilderPanel } from "./RoleBuilder.js";
import { RoleRuntime } from "./RoleRuntime.js";
import { RoleSection as Section } from "./RoleSection.js";
import { RoleSkills } from "./RoleSkills.js";
import { RoleTools } from "./RoleTools.js";
import { editRole, newRole } from "./role-draft.js";

export function RoleEditor({
  role,
  engineer,
  configuration,
  onSaved,
  onReturnFocus,
  onRuntimeApplied,
}: {
  role?: RoleDefinition;
  engineer?: string;
  configuration: GetConfigurationResponse;
  onSaved: () => void;
  onReturnFocus: () => void;
  onRuntimeApplied: () => void;
}) {
  const { t } = useTranslation();
  const editable = useCapability(Capability.AGENTS_MANAGE);
  const [draft, setDraft] = useState(() => {
    if (role) return clone(RoleDefinitionSchema, role);
    const draft = newRole();
    draft.modelConfig = configuration.modelConfigs.find(
      (item) => item.ref?.name === "default-model-config",
    )?.ref;
    return draft;
  });
  const [tab, setTab] = useState("prompt");
  const [harness, setHarness] = useState(configuration.defaultHarness?.name ?? "");
  const agent = configuration.agents.find(
    (item) => `${item.ref?.namespace}/${item.ref?.name}` === engineer,
  );
  const create = useMutation(ConsoleService.method.createRole);
  const update = useMutation(ConsoleService.method.updateRole);
  const access = useQuery(
    ConsoleService.method.explainTools,
    { engineer: draft.name },
    { enabled: /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(draft.name) },
  );
  const saving = create.isPending || update.isPending;
  const failure = create.error ?? update.error;
  const field =
    (key: "displayName" | "name" | "description" | "systemPrompt") =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const text = event.target.value;
      setDraft((value) =>
        editRole(value, (next) => {
          next[key] = text;
        }),
      );
    };
  // Builder drafts never rename an existing role or replace its stored version.
  const applyDraft = useCallback(
    (next: RoleDefinition) =>
      setDraft((current) =>
        role
          ? editRole(next, (value) => {
              value.name = current.name;
              value.displayName = current.displayName;
              value.resourceVersion = current.resourceVersion;
              value.modelConfig = current.modelConfig;
            })
          : next,
      ),
    [role],
  );
  async function save() {
    if (!editable) return;
    try {
      if (role) await update.mutateAsync({ role: draft });
      else
        await create.mutateAsync({
          role: draft,
          harness: configuration.harnesses.find((item) => item.ref?.name === harness)?.ref,
        });
      onSaved();
    } catch (error) {
      if (errorKey(error, "") === "configuration.invalidTools") setTab("tools");
    }
  }
  return (
    <SheetContent
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onReturnFocus();
      }}
      data-testid="role-editor"
      showCloseButton={false}
      className="h-dvh min-h-0 w-full gap-0 data-[side=right]:w-full sm:max-w-2xl data-[side=right]:sm:max-w-2xl"
    >
      <SheetHeader className="shrink-0 flex-row items-center justify-between border-b">
        <div>
          <SheetTitle>
            {t(
              !editable
                ? "management.view"
                : role
                  ? "configuration.editRole"
                  : "configuration.newRole",
            )}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {t("configuration.roleDescription")}
          </SheetDescription>
        </div>
        <SheetClose asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("configuration.close")}>
            <X />
          </Button>
        </SheetClose>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid shrink-0 gap-4 p-4 sm:grid-cols-2 sm:px-6">
          <div className="space-y-2">
            <Label htmlFor="role-label">{t("configuration.name")}</Label>
            <Input
              id="role-label"
              form="role-form"
              required={!role}
              maxLength={80}
              disabled={!!role}
              value={draft.displayName}
              placeholder={
                role ? engineerName({ id: draft.name, name: "", role: draft.name }) : undefined
              }
              onChange={field("displayName")}
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
              disabled={!!role}
              value={draft.name}
              onChange={field("name")}
            />
          </div>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
          <TabsList
            className="mx-4 mb-2 grid w-auto shrink-0 grid-cols-4 sm:mx-6"
            aria-label={t("configuration.sections")}
          >
            <TabsTrigger value="prompt">
              <NotebookPen />
              {t("configuration.promptTab")}
            </TabsTrigger>
            <TabsTrigger value="skills">
              <BookOpen />
              {t("configuration.skillsTab")}
            </TabsTrigger>
            <TabsTrigger value="tools">
              <Blocks />
              {t("configuration.toolsTab")}
            </TabsTrigger>
            <TabsTrigger value="runtime">
              <Play />
              {t("harness.tab")}
            </TabsTrigger>
          </TabsList>
          <Section value="prompt">
            <div className="space-y-5 p-4 sm:p-6">
              <form
                id="role-form"
                noValidate
                className="space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="role-description">{t("configuration.description")}</Label>
                  <Input
                    id="role-description"
                    maxLength={400}
                    readOnly={!editable}
                    value={draft.description}
                    onChange={field("description")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role-prompt">{t("configuration.instructions")}</Label>
                  <Textarea
                    id="role-prompt"
                    required
                    maxLength={24000}
                    rows={12}
                    readOnly={!editable}
                    value={draft.systemPrompt}
                    onChange={field("systemPrompt")}
                  />
                </div>
              </form>
              {editable && <RoleBuilderPanel onDraft={applyDraft} defaultOpen={!role} />}
            </div>
          </Section>
          <Section value="skills">
            <div className="p-4 sm:p-6">
              <RoleSkills role={draft} onChange={setDraft} />
            </div>
          </Section>
          <Section value="tools">
            <div className="p-4 sm:p-6">
              <RoleTools
                role={draft}
                builtinTools={
                  configuration.engineerTools.find(
                    (item) => `${item.engineer?.namespace}/${item.engineer?.name}` === engineer,
                  )?.builtinTools ?? []
                }
                servers={configuration.toolServers}
                requirements={access.data?.requirements}
                onChange={setDraft}
              />
            </div>
          </Section>
          <Section value="runtime">
            <RoleRuntime
              agent={agent}
              role={draft}
              configuration={configuration}
              harness={harness}
              onHarnessChange={setHarness}
              onChange={setDraft}
              onApplied={onRuntimeApplied}
              active={tab === "runtime"}
            />
          </Section>
        </Tabs>
      </div>
      {editable && (!role || tab !== "runtime") && (
        <div className="shrink-0 space-y-3 border-t p-4">
          {failure && (
            <Alert variant="destructive">
              <AlertDescription>
                {t(errorKey(failure, "configuration.saveFailed"))}
              </AlertDescription>
            </Alert>
          )}
          <Button type="submit" form="role-form" disabled={saving} className="w-full">
            {saving ? <LoaderCircle className="motion-safe:animate-spin" /> : <Save />}
            {t("configuration.save")}
          </Button>
        </div>
      )}
    </SheetContent>
  );
}
