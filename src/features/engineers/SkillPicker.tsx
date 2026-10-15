import { clone } from "@bufbuild/protobuf";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type Skill, SkillSchema } from "../../../gen/agentos/console/v1/role_pb.js";
import { managementClient } from "../../lib/console.js";
import { Failure, pageSize, useManagementPage } from "../management/ResourcePage.js";
import { PageControl } from "../shared/PageControl.js";

export function SkillPicker({
  selected,
  onSelect,
  onClose,
}: {
  selected: Skill[];
  onSelect: (skill: Skill) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const list = useManagementPage("skill-picker", (request) => managementClient.listSkills(request));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("management.fromCatalog")}</DialogTitle>
          <DialogDescription className="sr-only">{t("management.fromCatalog")}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t("management.search")}
          placeholder={t("management.search")}
          value={list.search}
          onChange={(event) => list.onSearch(event.target.value)}
        />
        <Failure error={list.error} />
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {list.data?.skills.map((item) => (
            <Button
              key={item.skill?.name}
              variant="outline"
              className="h-auto w-full justify-start py-3 text-left"
              disabled={!item.skill || selected.some((skill) => skill.name === item.skill?.name)}
              onClick={() => {
                if (item.skill) {
                  onSelect(clone(SkillSchema, item.skill));
                  onClose();
                }
              }}
            >
              <span>
                <span className="block">{item.skill?.name}</span>
                {item.description && (
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    {item.description}
                  </span>
                )}
              </span>
            </Button>
          ))}
          {!list.isPending && !list.data?.totalSize && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("management.empty")}
            </p>
          )}
        </div>
        <PageControl
          page={list.page}
          pages={Math.ceil((list.data?.totalSize ?? 0) / pageSize)}
          onPage={list.onPage}
          label={t("pagination.label", { title: t("management.tabs.skills") })}
        />
      </DialogContent>
    </Dialog>
  );
}
