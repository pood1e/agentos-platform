import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function TaskWorkspace() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const value = location.pathname.startsWith("/tasks/automations") ? "automations" : "executions";
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
      <header className="shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">{t("navigation.tasks")}</h1>
        <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
          {t("automation.workspaceHint")}
        </p>
      </header>
      <Tabs
        value={value}
        onValueChange={(next) =>
          void navigate(next === "automations" ? "/tasks/automations" : "/tasks")
        }
        className="shrink-0 border-b"
      >
        <TabsList variant="line" className="h-10 gap-5 p-0" aria-label={t("automation.taskViews")}>
          <TabsTrigger value="executions" className="gap-2 px-0 pb-3 after:bottom-0!">
            <History />
            {t("automation.executions")}
          </TabsTrigger>
          <TabsTrigger value="automations" className="gap-2 px-0 pb-3 after:bottom-0!">
            <Workflow />
            {t("automation.title")}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Outlet />
    </section>
  );
}

import { History, Workflow } from "lucide-react";
