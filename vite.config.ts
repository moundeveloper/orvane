import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { mcpDiscovery } from "./server/discovery.ts";
import { localStorageApi } from "./server/storage-api.ts";
import { gitApi } from "./server/git-api.ts";
import { projectsApi } from "./server/projects-api.ts";
import { notesApi } from "./server/notes-api.ts";

// https://vite.dev/config/
export default defineConfig({
  // Electron's newer Chromium requires the unprefixed backdrop-filter.
  // Lightning CSS currently folds it into only -webkit-backdrop-filter,
  // which makes the frosted header disappear in the production desktop app.
  build: { cssMinify: "esbuild" },
  plugins: [
    // <webview> is Electron's built-in element (desktop Browser app).
    vue({
      template: {
        compilerOptions: { isCustomElement: (tag) => tag === "webview" },
      },
    }),
    notesApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    projectsApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    gitApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    localStorageApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    mcpDiscovery(
      process.env.ORVANE_MCP_STATE_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
