import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Capability } from "../../../gen/agentos/authorization/v1/permission_pb.js";
import type { Harness } from "../../../gen/kagent/api/v1/harnesses_pb.js";
import { object } from "../../../shared/json.js";
import { useCapability } from "../../lib/access.js";
import { managementClient } from "../../lib/console.js";
import { ConfirmDelete } from "../shared/ConfirmDelete.js";
import { HarnessIcon, runtimeName } from "../shared/HarnessIcon.js";
import { harnessMetadata, harnessName } from "../shared/HarnessPicker.js";
import { ResourceSheet } from "../shared/ResourceDialog.js";
import { ResourcePage } from "../shared/ResourcePage.js";
import { RowActions } from "../shared/RowActions.js";
import { HarnessEditor } from "./HarnessEditor.js";

export function HarnessesPage() {
  const { t } = useTranslation();
  const editable = useCapability(Capability.HARNESSES_MANAGE);
  const list = useQuery({
    queryKey: ["management", "harnesses"],
    queryFn: () => managementClient.listHarnesses({}),
  });
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Harness>();
  const [removing, setRemoving] = useState<Harness>();
  const visible = (list.data?.harnesses ?? []).filter((item) =>
    `${harnessName(item)} ${runtimeName(item.runtime)} ${item.workloadImage}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const edit = (harness?: Harness) => {
    setSelected(harness);
    setOpen(true);
  };
  return (
    <>
      <ResourcePage
        title={t("harness.title")}
        query={query}
        onQuery={setQuery}
        total={visible.length}
        pending={list.isPending}
        fetching={list.isFetching}
        error={list.error}
        onRefresh={() => void list.refetch()}
        onAdd={editable ? () => edit() : undefined}
        page={0}
        onPage={() => {}}
        pagination={false}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("configuration.name")}</TableHead>
              <TableHead>{t("harness.runtime")}</TableHead>
              <TableHead>{t("harness.image")}</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">{t("configuration.configure")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((item) => (
              <TableRow
                key={harnessName(item)}
                data-testid="harness-row"
                data-harness={harnessName(item)}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-3">
                    <HarnessIcon runtime={item.runtime} />
                    {harnessName(item)}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{runtimeName(item.runtime)}</Badge>
                </TableCell>
                <TableCell
                  className="max-w-xl truncate font-mono text-xs"
                  title={item.workloadImage}
                >
                  {item.workloadImage}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <RowActions
                    editable={editable}
                    editLabel="configuration.configure"
                    deleteDisabled={
                      object(harnessMetadata(item).labels)["app.kubernetes.io/managed-by"] ===
                      "Helm"
                    }
                    onOpen={() => edit(item)}
                    onDelete={() => setRemoving(item)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ResourcePage>
      <ResourceSheet
        title={t(!editable ? "management.view" : selected ? "harness.edit" : "harness.add")}
        open={open}
        onOpenChange={setOpen}
      >
        {open && (
          <HarnessEditor
            key={selected ? harnessName(selected) : "new"}
            harness={selected}
            defaults={list.data?.harnesses.find((item) => harnessName(item) === "standard")}
            onSaved={() => {
              setOpen(false);
              void list.refetch();
            }}
          />
        )}
      </ResourceSheet>
      {editable && removing && (
        <ConfirmDelete
          title={t("management.delete")}
          description={t("harness.deleteConfirm", { name: harnessName(removing) })}
          onConfirm={async () => {
            await managementClient.deleteHarness({
              ref: removing.ref,
              resourceVersion: String(harnessMetadata(removing).resourceVersion ?? ""),
            });
            void list.refetch();
          }}
          onClose={() => setRemoving(undefined)}
        />
      )}
    </>
  );
}
