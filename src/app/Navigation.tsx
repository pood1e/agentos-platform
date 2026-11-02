import {
  Blocks,
  BookOpen,
  BrainCircuit,
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

const sections = [
  { path: "/chat", label: "navigation.chat", icon: MessageCircle },
  { path: "/agents", label: "navigation.agents", icon: Users },
  { path: "/workflows", label: "workflow.title", icon: GitBranch },
  {
    path: "/agents/knowledge",
    label: "management.tabs.knowledge",
    icon: BrainCircuit,
  },
];
const settings = [
  { path: "/agents/models", label: "management.tabs.models", icon: Cpu },
  { path: "/agents/mcp", label: "management.tabs.mcp", icon: Blocks },
  { path: "/agents/harnesses", label: "management.tabs.harnesses", icon: Play },
  { path: "/agents/skills", label: "management.tabs.skills", icon: BookOpen },
];

export function Navigation({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const access = useAccess();
  const links = (items: typeof settings) =>
    items.map(({ path, label, icon: Icon }) => (
      <Button
        key={path}
        asChild
        variant="ghost"
        className="h-9 w-full justify-start gap-3 aria-[current=page]:bg-secondary aria-[current=page]:text-secondary-foreground"
      >
        <NavLink to={path} end={path === "/agents"} onClick={onNavigate}>
          <Icon />
          {t(label)}
        </NavLink>
      </Button>
    ));
  const permitted = () => !!access.data;
  const visibleSettings = settings.filter(permitted);
  return (
    <nav
      aria-label={t("navigation.main")}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3"
    >
      {links(sections.filter(permitted))}
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
