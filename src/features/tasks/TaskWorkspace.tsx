import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function TaskWorkspace() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const value = location.pathname.startsWith("/tasks/automations") ? "automations" : "executions";
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <Tabs
        value={value}
        onValueChange={(next) =>
          void navigate(next === "automations" ? "/tasks/automations" : "/tasks")
        }
      >
        <TabsList aria-label={t("automation.taskViews")}>
          <TabsTrigger value="executions">{t("automation.executions")}</TabsTrigger>
          <TabsTrigger value="automations">{t("automation.title")}</TabsTrigger>
        </TabsList>
      </Tabs>
      <Outlet />
    </section>
  );
}
