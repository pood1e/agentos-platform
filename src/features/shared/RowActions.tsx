import { Eye, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** Row controls of a managed resource; read-only viewers can open it but not delete it. */
export function RowActions({
  editable,
  editLabel = "management.edit",
  deleteDisabled = false,
  onOpen,
  onDelete,
}: {
  editable: boolean;
  editLabel?: string;
  deleteDisabled?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t(editable ? editLabel : "management.view")}
        onClick={onOpen}
      >
        {editable ? <Pencil /> : <Eye />}
      </Button>
      {editable && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("management.delete")}
          disabled={deleteDisabled}
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      )}
    </>
  );
}
