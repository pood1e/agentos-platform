import { useQuery } from "@tanstack/react-query";
import { Layers3, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { listWorkspaces } from "../lib/workspace-directory.js";
import { workspaceURL } from "../lib/workspace-route.js";
import { LanguageSelect } from "./LanguageSelect.js";
import { ThemeSelect } from "./ThemeSelect.js";

export function WorkspaceDirectory() {
  const { t } = useTranslation();
  const directory = useQuery({
    queryKey: ["workspaces"],
    queryFn: ({ signal }) => listWorkspaces(signal),
    retry: false,
  });
  return (
    <div className="min-h-dvh bg-background">
      <header className="flex items-center gap-3 border-b bg-card px-6 py-4">
        <Layers3 className="size-6 text-primary" />
        <strong className="text-lg">AgentOS</strong>
        <div className="ml-auto flex items-center gap-2">
          <ThemeSelect />
          <LanguageSelect />
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-5 p-6 sm:p-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("workspaces.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("workspaces.hint")}</p>
        </div>
        {directory.isPending && (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {t("management.loading")}
          </div>
        )}
        {directory.isError && (
          <Alert variant="destructive">
            <AlertDescription>{t("workspaces.failed")}</AlertDescription>
          </Alert>
        )}
        {directory.data?.partial && (
          <Alert data-testid="workspaces-partial">
            <AlertDescription>{t("workspaces.partial")}</AlertDescription>
          </Alert>
        )}
        {directory.isSuccess && directory.data.workspaces.length === 0 && (
          <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
            {t(directory.data.partial ? "workspaces.partial" : "workspaces.empty")}
          </p>
        )}
        {directory.isSuccess && directory.data.workspaces.length > 0 && (
          <div className="overflow-hidden rounded-xl border bg-card">
            {directory.data.workspaces.map((workspace) => (
              <div
                key={workspace.uid}
                className="flex items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{workspace.namespace}</div>
                  <div className="truncate text-xs text-muted-foreground">{workspace.uid}</div>
                </div>
                <Button asChild variant="outline" size="sm">
                  <a href={workspaceURL(workspace)}>{t("workspaces.open")}</a>
                </Button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
