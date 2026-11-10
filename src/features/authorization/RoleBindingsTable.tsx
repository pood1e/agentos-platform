import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AccessRole, RoleBinding } from "../../../gen/kagent/api/v1/authorization_pb.js";
import { BindingSubject, subjectName } from "./BindingSubject.js";
import type { RoleBindingGroup } from "./role-bindings.js";

export function RoleBindingsTable({
  groups,
  current,
  editableRoles,
  onAddRole,
  onRevoke,
}: {
  groups: RoleBindingGroup[];
  current: string;
  editableRoles: AccessRole[];
  onAddRole: (group: RoleBindingGroup) => void;
  onRevoke: (binding: RoleBinding) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="block table-fixed sm:table" aria-label={t("authorization.subjectRoles")}>
        <TableHeader className="sr-only sm:not-sr-only sm:table-header-group">
          <TableRow>
            <TableHead className="w-2/5">{t("authorization.subject")}</TableHead>
            <TableHead>{t("authorization.role")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="block sm:table-row-group">
          {groups.map((group) => (
            <TableRow key={group.key} className="block sm:table-row">
              <TableCell className="block min-w-0 pb-1 align-top sm:table-cell sm:pb-2">
                <BindingSubject value={group.subject} current={current} />
              </TableCell>
              <TableCell className="block pb-3 pt-1 sm:table-cell sm:py-2">
                <div className="flex flex-wrap items-center gap-2">
                  {group.bindings.map((binding) => (
                    <Badge
                      key={binding.role}
                      variant="secondary"
                      className="h-7 gap-1.5"
                      title={t(`authorization.roleHelp.${binding.role}`)}
                    >
                      {t(`authorization.roles.${binding.role}`)}
                      {editableRoles.includes(binding.role) && (
                        <button
                          type="button"
                          className="-mr-1 flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
                          aria-label={t("authorization.revokeRole", {
                            role: t(`authorization.roles.${binding.role}`),
                            subject: subjectName(group.subject),
                          })}
                          onClick={() => onRevoke(binding)}
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </Badge>
                  ))}
                  {group.subject &&
                    editableRoles.some(
                      (role) => !group.bindings.some((binding) => binding.role === role),
                    ) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => onAddRole(group)}
                      >
                        <Plus />
                        {t("authorization.addRole")}
                      </Button>
                    )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
