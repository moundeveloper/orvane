import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { mcpDiscovery } from "./server/discovery.ts";
import { localStorageApi } from "./server/storage-api.ts";
import { gitApi } from "./server/git-api.ts";
import { projectsApi } from "./server/projects-api.ts";
import { notesApi } from "./server/notes-api.ts";
import { uimakerApi } from "./server/uimaker-api.ts";
import { siteMemoryApi } from "./server/site-memory-api.ts";
import { workspaceMemoryApi } from "./server/workspace-memory-api.ts";
import { customToolsApi } from "./server/custom-tools-api.ts";
import { certificatesApi } from "./server/certificates-api.ts";
import { agentSessionsApi } from "./server/agent-sessions-api.ts";
import { filesApi } from "./server/files-api.ts";
import { netSuiteWorkspaceApi } from "./server/netsuite-workspace-api.ts";
import { terminalApi } from "./server/terminal.ts";

// https://vite.dev/config/
export default defineConfig({
  // Electron's newer Chromium requires the unprefixed backdrop-filter.
  // Lightning CSS currently folds it into only -webkit-backdrop-filter,
  // which makes the frosted header disappear in the production desktop app.
  build: { cssMinify: "esbuild" },
  plugins: [
    agentSessionsApi(process.env.ORVANE_DATA_DIR || fileURLToPath(new URL("./.orvane", import.meta.url))),
    certificatesApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    // <webview> is Electron's built-in element (desktop Browser app).
    vue({
      template: {
        compilerOptions: { isCustomElement: (tag) => tag === "webview" },
      },
    }),
    terminalApi(),
    filesApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    notesApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    uimakerApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    netSuiteWorkspaceApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    siteMemoryApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    workspaceMemoryApi(
      process.env.ORVANE_DATA_DIR ||
        fileURLToPath(new URL("./.orvane", import.meta.url)),
    ),
    customToolsApi(
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
