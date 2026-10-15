import "@xyflow/react/dist/style.css";
import "./styles.css";
import "./i18n/index.js";
import { TransportProvider } from "@connectrpc/connect-query";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "./app/router.js";
import { themeOptions } from "./app/theme.js";
import { connection } from "./lib/connection.js";
import { transport } from "./lib/console.js";
import { errorKey, unreachable } from "./lib/errors.js";

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (unreachable(error)) connection.failed(errorKey(error, "connection.reconnecting"));
    },
    onSuccess: () => connection.succeeded(),
  }),
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider {...themeOptions}>
      <TransportProvider transport={transport}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={250}>
            <RouterProvider router={router} />
          </TooltipProvider>
        </QueryClientProvider>
      </TransportProvider>
    </ThemeProvider>
  </StrictMode>,
);
