import { LoaderCircle, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "../../lib/utils.js";

export function ResourceSheet({
  title,
  open,
  onOpenChange,
  children,
  className,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        showCloseButton={false}
        className={cn("w-full gap-0 sm:max-w-2xl data-[side=right]:sm:max-w-2xl", className)}
      >
        <SheetHeader className="border-b">
          <div className="flex items-start justify-between gap-3">
            <SheetTitle className="min-w-0 text-base leading-6 break-words">{title}</SheetTitle>
            <SheetClose asChild>
              <Button
                className="shrink-0"
                variant="ghost"
                size="icon-sm"
                aria-label={t("common.close")}
              >
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
