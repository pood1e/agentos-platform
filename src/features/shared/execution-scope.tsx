import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdministrator } from "../../lib/access.js";

export interface ExecutionScope {
  administrator: boolean;
  systemOnly: boolean;
  select: (systemOnly: boolean) => void;
}

/** Personal executions, or for administrators those of other initiators, selected in the URL. */
export function useExecutionScope(): ExecutionScope {
  const administrator = useAdministrator();
  const [params, setParams] = useSearchParams();
  const select = (systemOnly: boolean) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (systemOnly) next.set("scope", "system");
        else next.delete("scope");
        return next;
      },
      { replace: true },
    );
  return { administrator, systemOnly: administrator && params.get("scope") === "system", select };
}

export function ExecutionScopeTabs({ scope }: { scope: ExecutionScope }) {
  const { t } = useTranslation();
  if (!scope.administrator) return null;
  return (
    <Tabs
      value={scope.systemOnly ? "system" : "personal"}
      onValueChange={(value) => scope.select(value === "system")}
    >
      <TabsList aria-label={t("executionScope.label")}>
        <TabsTrigger value="personal">{t("executionScope.personal")}</TabsTrigger>
        <TabsTrigger value="system">{t("executionScope.system")}</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
