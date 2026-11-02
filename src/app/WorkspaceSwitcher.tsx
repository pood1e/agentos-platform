import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccess } from "../lib/access.js";
import { listWorkspaces } from "../lib/workspace-directory.js";
import { workspaceURL } from "../lib/workspace-route.js";

export function WorkspaceSwitcher() {
  const { t } = useTranslation();
  const access = useAccess();
  const directory = useQuery({
    queryKey: ["workspaces"],
    queryFn: ({ signal }) => listWorkspaces(signal),
    enabled: !!access.data,
    staleTime: 10_000,
    retry: false,
  });
  const current = access.data?.workspace;
  if (!current)
    return (
      <Button asChild variant="outline" size="sm">
        <a href="/">{t("workspaces.all")}</a>
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-w-0 max-w-48 gap-2"
          aria-label={t("workspaces.switch")}
        >
          <span className="truncate">{current.namespace}</span>
          <ChevronDown className="size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {directory.isError && (
          <DropdownMenuItem disabled>{t("workspaces.failed")}</DropdownMenuItem>
        )}
        {directory.data?.map((workspace) => (
          <DropdownMenuItem key={workspace.uid} asChild>
            <a
              href={workspaceURL(workspace)}
              aria-current={workspace.uid === current.uid ? "page" : undefined}
            >
              {workspace.namespace}
            </a>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem asChild>
          <a href="/">{t("workspaces.all")}</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
