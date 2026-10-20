import { Layers3, Menu } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { usePack } from "@/lib/pack";
import { Connection } from "./Connection.js";
import { LanguageSelect } from "./LanguageSelect.js";
import { Navigation } from "./Navigation.js";
import { PendingApprovals } from "./PendingApprovals.js";
import { ThemeSelect } from "./ThemeSelect.js";

export function Topbar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = usePack().title || "AgentOS";
  return (
    <header className="shrink-0 border-b bg-card px-4 sm:px-7">
      <div className="flex items-center gap-3 py-3">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="lg:hidden"
              aria-label={t("navigation.main")}
            >
              <Menu />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64" aria-describedby={undefined}>
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
            </SheetHeader>
            <Navigation onNavigate={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
        <a href="/" className="flex min-w-0 items-center gap-2.5" aria-label={t("navigation.home")}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Layers3 className="size-5" />
          </span>
          <strong className="truncate text-lg tracking-tight">{title}</strong>
        </a>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <PendingApprovals />
          <Connection />
          <ThemeSelect />
          <LanguageSelect />
        </div>
      </div>
    </header>
  );
}
