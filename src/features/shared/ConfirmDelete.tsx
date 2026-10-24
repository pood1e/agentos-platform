import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorKey } from "../../lib/errors.js";

export function ConfirmDelete({
  title,
  description,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function confirm() {
    setPending(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error != null && (
          <Alert variant="destructive">
            <AlertDescription>{t(errorKey(error, "management.unavailable"))}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {t("management.cancel")}
          </Button>
          <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
            {pending && <LoaderCircle className="animate-spin" />}
            {t("management.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
