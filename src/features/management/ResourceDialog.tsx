import { LoaderCircle, Save, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Failure } from "./ResourcePage.js";

export function ResourceSheet({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showCloseButton={false}
        className="w-full gap-0 sm:max-w-2xl data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="border-b">
          <div className="flex items-center justify-between">
            <SheetTitle>{title}</SheetTitle>
            <SheetClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("common.close")}>
                <X />
              </Button>
            </SheetClose>
          </div>
          <SheetDescription className="sr-only">{title}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export function SaveButton({ pending }: { pending: boolean }) {
  const { t } = useTranslation();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? <LoaderCircle className="animate-spin" /> : <Save />}
      {t("configuration.save")}
    </Button>
  );
}

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
        <Failure error={error} />
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
