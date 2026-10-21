import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { ThemeProvider } from "next-themes";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defineConfig } from "vitest/config";
import { themeOptions } from "./src/app/theme.js";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "theme-bootstrap",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html.replace(
            "<head>",
            `<head>${renderToStaticMarkup(createElement(ThemeProvider, themeOptions))}`,
          ),
      },
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/agentos.console.v1.ConsoleService": "http://127.0.0.1:8080",
      "/agentos.management.v1.ManagementService": "http://127.0.0.1:8080",
      "/pack/": "http://127.0.0.1:8080",
      "/speech/": { target: "http://127.0.0.1:8080", ws: true },
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
