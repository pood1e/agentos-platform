import { Blocks, BookOpen, BrainCircuit, Cpu, Network, Play, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAccess } from "@/lib/access";

const sections = [
  { path: "/engineers", key: "team", icon: Users },
  { path: "/engineers/knowledge", key: "knowledge", icon: BrainCircuit },
  { path: "/engineers/skills", key: "skills", icon: BookOpen },
  { path: "/engineers/mcp", key: "mcp", icon: Blocks },
  { path: "/engineers/models", key: "models", icon: Cpu },
  { path: "/engineers/harnesses", key: "harnesses", icon: Play },
  { path: "/engineers/environments", key: "environments", icon: Network },
];

export function AdvancedLayout() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const access = useAccess();
  if (!access.data?.manage) return null;
  return (
    <div data-testid="advanced" className="flex min-h-0 flex-1 flex-col gap-5">
      <Tabs value={pathname} className="shrink-0 overflow-x-auto">
        <TabsList className="h-10 w-max" aria-label={t("management.sections")}>
          {sections.map(({ path, key, icon: Icon }) => (
            <TabsTrigger key={path} value={path} asChild>
              <NavLink to={path} end>
                <Icon />
                {t(`management.tabs.${key}`)}
              </NavLink>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Outlet />
    </div>
  );
}
