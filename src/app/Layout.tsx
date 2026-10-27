import { Code, ConnectError } from "@connectrpc/connect";
import {
  addStaticKeyToTransport,
  TransportProvider,
  useTransport,
} from "@connectrpc/connect-query";
import { Activity, LoaderCircle } from "lucide-react";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { Toaster } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useAccess } from "../lib/access.js";
import { useOutage } from "../lib/connection.js";
import { applyPackLocales, usePack } from "../lib/pack.js";
import { Navigation } from "./Navigation.js";
import { Topbar } from "./Topbar.js";

export function Layout({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const outage = useOutage();
  const pack = usePack();
  const access = useAccess({ poll: true });
  useEffect(() => {
    if (access.error instanceof ConnectError && access.error.code === Code.Unauthenticated)
      window.location.reload();
  }, [access.error]);
  useEffect(() => {
    // Background execution needs the user's offline grant; the API origin completes it.
    if (!access.data || access.data.delegated || !access.data.delegationUrl) return;
    const delegation = new URL(access.data.delegationUrl);
    delegation.searchParams.set("return_to", window.location.href);
    window.location.assign(delegation);
  }, [access.data]);
  const transport = useTransport();
  const scope = JSON.stringify([access.data?.workspace, access.data?.subject]);
  const scopedTransport = useMemo(
    () => addStaticKeyToTransport(transport, scope),
    [transport, scope],
  );
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    applyPackLocales(pack);
    document.title = pack.title || "AgentOS";
  }, [pack]);
  return (
    <TransportProvider key={scope} transport={scopedTransport}>
      <div className="flex h-dvh flex-col overflow-hidden">
        <Topbar />
        <Toaster position="top-right" theme={resolvedTheme === "dark" ? "dark" : "light"} />
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-52 shrink-0 flex-col border-r bg-card lg:flex">
            <Navigation />
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
            {outage && (
              <Alert variant="destructive" data-testid="error-banner" className="shrink-0">
                <Activity />
                <AlertDescription>{t(outage)}</AlertDescription>
              </Alert>
            )}
            {children ?? <Outlet />}
          </main>
        </div>
      </div>
    </TransportProvider>
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
