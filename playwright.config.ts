import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const cachedBrowser = `${process.env.LOCALAPPDATA}\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe`;
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync(cachedBrowser) ? cachedBrowser : undefined);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  workers: 3,
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath },
  },
  webServer: {
    command:
      "pnpm exec vite --host 127.0.0.1 --port 5174 --strictPort --mode test-storage",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
  },
});
