import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { ThemeProvider } from "next-themes";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { defineConfig } from "vitest/config";
import { themeOptions } from "./src/app/theme.js";

// The platform API accepts only bearer tokens; development forwards one from the shell.
const api = {
  target: process.env.AGENTOS_API_URL ?? "http://127.0.0.1:8080",
  changeOrigin: true,
  headers: process.env.AGENTOS_API_TOKEN
    ? { authorization: `Bearer ${process.env.AGENTOS_API_TOKEN}` }
    : undefined,
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@ricky0123/vad-web/dist/{vad.worklet.bundle.min.js,silero_vad_v6.onnx}",
          dest: "speech-vad",
          rename: { stripBase: true },
        },
        {
          src: "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs}",
          dest: "speech-vad",
          rename: { stripBase: true },
        },
      ],
    }),
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
      "/agentos.console.v1.ConsoleService": api,
      "/agentos.management.v1.ManagementService": api,
      "/agentos.automation.v1.AutomationService": api,
      "/pack/": api,
      "/speech/": { ...api, ws: true },
    },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
