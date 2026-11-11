import { create } from "@bufbuild/protobuf";
import {
  Blocks,
  BookOpen,
  CalendarClock,
  Cpu,
  GitBranch,
  ListChecks,
  MessageCircle,
  Play,
  ShieldCheck,
  Users,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import { Button } from "@/components/ui/button";
import { useAccess } from "@/lib/access";
import { useResourceAccess } from "@/lib/authorization";
import {
  AuthorizationResourceSchema,
  Permission,
} from "../../gen/kagent/api/v1/authorization_pb.js";

const sections = [
  { path: "/chat", label: "navigation.chat", icon: MessageCircle },
  { path: "/tasks", label: "task.listTitle", icon: ListChecks },
  { path: "/schedules", label: "schedule.title", icon: CalendarClock },
  { path: "/agents", label: "navigation.agents", icon: Users },
  { path: "/workflows", label: "workflow.title", icon: GitBranch },
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
  const authorization = useResourceAccess(
    access.data?.workspace
      ? create(AuthorizationResourceSchema, {
          resource: { case: "workspace", value: access.data.workspace },
        })
      : undefined,
  );
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
  const visibleSettings = [
    ...settings,
    ...(authorization.isSuccess &&
    authorization.data?.allowedActions.includes(Permission.ACCESS_READ)
      ? [{ path: "/authorization", label: "authorization.title", icon: ShieldCheck }]
      : []),
  ].filter(permitted);
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
