import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAdministrator } from "../../lib/access.js";
import { useSearchParam } from "../../lib/use-search-param.js";

export interface ExecutionScope {
  administrator: boolean;
  systemOnly: boolean;
  select: (systemOnly: boolean) => void;
}

/** Personal executions, or for administrators those of other initiators, selected in the URL. */
export function useExecutionScope(): ExecutionScope {
  const administrator = useAdministrator();
  const [scope, setScope] = useSearchParam("scope");
  return {
    administrator,
    systemOnly: administrator && scope === "system",
    select: (systemOnly) => setScope(systemOnly ? "system" : ""),
  };
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
