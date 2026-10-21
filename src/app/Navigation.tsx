import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  BookOpen,
  BrainCircuit,
  ClipboardCheck,
  Cpu,
  GitBranch,
  MessageCircle,
  Play,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/lib/access";
import { evaluationClient } from "@/lib/console";
import { Capability } from "../../gen/agentos/authorization/v1/permission_pb.js";
import { can } from "../../shared/permissions.js";
import { managementCapability } from "../lib/permissions.js";

const sections = [
  { path: "/chat", label: "navigation.chat", icon: MessageCircle },
  { path: "/tasks", label: "navigation.tasks", icon: GitBranch },
  { path: "/engineers", label: "navigation.agents", icon: Users },
  {
    path: "/engineers/knowledge",
    label: "management.tabs.knowledge",
    icon: BrainCircuit,
  },
  {
    path: "/engineers/evaluation",
    label: "management.tabs.evaluation",
    icon: ClipboardCheck,
  },
];
const settings = [
  { path: "/engineers/models", label: "management.tabs.models", icon: Cpu },
  { path: "/engineers/mcp", label: "management.tabs.mcp", icon: Blocks },
  { path: "/engineers/harnesses", label: "management.tabs.harnesses", icon: Play },
  { path: "/engineers/skills", label: "management.tabs.skills", icon: BookOpen },
];

export function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const access = useAccess();
  const evaluation = useQuery({
    queryKey: ["evaluation"],
    queryFn: ({ signal }) => evaluationClient.listCandidates({}, { signal }),
    enabled: can(access.data, Capability.EVALUATIONS_MANAGE),
    staleTime: 60_000,
    retry: false,
  });
  const links = (items: typeof settings) =>
    items.map(({ path, label, icon: Icon }) => (
      <Button
        key={path}
        asChild
        variant="ghost"
        className="h-9 w-full justify-start gap-3 aria-[current=page]:bg-secondary aria-[current=page]:text-secondary-foreground"
      >
        <NavLink to={path} end={path === "/engineers"} onClick={onNavigate}>
          <Icon />
          {t(label)}
        </NavLink>
      </Button>
    ));
  const permitted = (item: (typeof settings)[number]) => {
    const capability = managementCapability(item.path);
    return !capability || can(access.data, capability);
  };
  const visibleSettings = settings.filter(permitted);
  return (
    <nav
      aria-label={t("navigation.main")}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3"
    >
      {links(
        sections.filter(
          (item) =>
            permitted(item) && (item.path !== "/engineers/evaluation" || evaluation.isSuccess),
        ),
      )}
      {!!visibleSettings.length && (
        <>
          <p className="mb-1 mt-6 px-3 text-xs font-medium text-muted-foreground">
            {t("navigation.settings")}
          </p>
          {links(visibleSettings)}
        </>
      )}
    </nav>
  );
}
