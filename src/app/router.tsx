import { createBrowserRouter, Navigate } from "react-router";
import { ConnectionKind } from "../../gen/agentos/management/v1/management_pb.js";
import { lastConversation } from "../features/chat/conversation-storage.js";
import { AdvancedLayout } from "../features/management/AdvancedLayout.js";
import { useAccess } from "../lib/access.js";
import { Layout, PendingLayout } from "./Layout.js";

const home = () => {
  const access = useAccess();
  if (!access.data) return <PendingLayout />;
  const contextId = lastConversation(access.data);
  return <Navigate to={contextId || "/chat"} replace />;
};

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    HydrateFallback: PendingLayout,
    children: [
      { index: true, Component: home },
      {
        path: "chat/:contextId?",
        lazy: async () => ({ Component: (await import("../features/chat/ChatPage.js")).ChatPage }),
      },
      {
        path: "executions/:agent/:session",
        lazy: async () => ({
          Component: (await import("../features/tasks/ExecutionPage.js")).ExecutionPage,
        }),
      },
      {
        path: "engineers",
        element: <AdvancedLayout />,
        children: [
          {
            index: true,
            lazy: async () => ({
              Component: (await import("../features/engineers/EngineersPage.js")).EngineersPage,
            }),
          },
          {
            path: "knowledge",
            lazy: async () => ({
              Component: (await import("../features/management/KnowledgePage.js")).KnowledgePage,
            }),
          },
          {
            path: "skills",
            lazy: async () => ({
              Component: (await import("../features/management/SkillsPage.js")).SkillsPage,
            }),
          },
          {
            path: "mcp",
            lazy: async () => {
              const { ConnectionsPage } = await import("../features/management/ConnectionsPage.js");
              return { element: <ConnectionsPage key="mcp" kind={ConnectionKind.MCP} /> };
            },
          },
          {
            path: "models",
            lazy: async () => ({
              Component: (await import("../features/management/ModelsPage.js")).ModelsPage,
            }),
          },
          {
            path: "harnesses",
            lazy: async () => ({
              Component: (await import("../features/management/HarnessesPage.js")).HarnessesPage,
            }),
          },
        ],
      },
      { path: "*", element: <Navigate to="/chat" replace /> },
    ],
  },
]);
