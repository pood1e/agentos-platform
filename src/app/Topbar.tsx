import { GitBranch, Layers3, MessageCircle, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePack } from "@/lib/pack";
import { Connection } from "./Connection.js";
import { LanguageSelect } from "./LanguageSelect.js";
import { ThemeSelect } from "./ThemeSelect.js";

const sections = [
  { value: "chat", label: "navigation.chat", icon: MessageCircle },
  { value: "tasks", label: "navigation.tasks", icon: GitBranch },
  { value: "engineers", label: "navigation.advanced", icon: Settings2 },
] as const;

export function Topbar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const section = useLocation().pathname.split("/")[1] || "chat";
  const title = usePack().title || "AgentOS";
  return (
    <header className="shrink-0 border-b bg-card px-4 sm:px-7">
      <div className="flex flex-wrap items-center gap-3 py-3 sm:gap-5 sm:py-4">
        <a href="/" className="flex items-center gap-2.5" aria-label={t("navigation.home")}>
          <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Layers3 className="size-5" />
          </span>
          <strong className="text-lg tracking-tight">
            {title}{" "}
            <span className="hidden font-normal text-muted-foreground sm:inline">
              {t("navigation.workbench")}
            </span>
          </strong>
        </a>
        <Tabs
          value={section}
          onValueChange={(value) => navigate(`/${value}`)}
          className="order-last shrink-0 lg:order-none"
        >
          <TabsList aria-label={t("navigation.main")}>
            {sections.map(({ value, label, icon: Icon }) => (
              <TabsTrigger key={value} value={value}>
                <Icon className="hidden size-4 sm:block" />
                {t(label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="ml-auto flex items-center gap-2">
          <Connection />
          <ThemeSelect />
          <LanguageSelect />
        </div>
      </div>
    </header>
  );
}
