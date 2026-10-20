import { Activity, LoaderCircle } from "lucide-react";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useNavigate } from "react-router";
import { Toaster, toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useOutage } from "../lib/connection.js";
import { applyPackLocales, usePack } from "../lib/pack.js";
import { Topbar } from "./Topbar.js";

export function Layout({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const outage = useOutage();
  const pack = usePack();
  const navigate = useNavigate(),
    { resolvedTheme } = useTheme();
  useEffect(() => {
    const created = (event: Event) =>
      toast.info(t("evaluation.created"), {
        action: {
          label: t("evaluation.review"),
          onClick: () =>
            navigate(
              `/engineers/evaluation?candidate=${encodeURIComponent((event as CustomEvent<string>).detail)}`,
            ),
        },
      });
    window.addEventListener("agentos:candidate", created);
    return () => window.removeEventListener("agentos:candidate", created);
  }, [navigate, t]);
  useEffect(() => {
    applyPackLocales(pack);
    document.title = pack.title || "AgentOS";
  }, [pack]);
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <Topbar />
      <Toaster position="top-right" theme={resolvedTheme === "dark" ? "dark" : "light"} />
      <main className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-7">
        {outage && (
          <Alert variant="destructive" data-testid="error-banner" className="shrink-0">
            <Activity />
            <AlertDescription>{t(outage)}</AlertDescription>
          </Alert>
        )}
        {children ?? <Outlet />}
      </main>
    </div>
  );
}

export function PendingLayout() {
  const { t } = useTranslation();
  return (
    <Layout>
      <div
        role="status"
        aria-label={t("management.loading")}
        className="flex flex-1 items-center justify-center"
      >
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    </Layout>
  );
}
