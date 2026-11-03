import { _electron, type Page, type BrowserContext } from "@playwright/test";
import { createRequire } from "node:module";
import { join } from "node:path";

export async function launchElectronFixture(
  root: string,
  directory: string,
  port: number,
  fixture = { scripts: 1000 },
) {
  const require = createRequire(import.meta.url);
  const env = {
    ...process.env,
    ORVANE_PORT: String(port),
    ORVANE_USER_DATA: join(directory, "electron-profile"),
    ORVANE_DATA_DIR: directory,
    ORVANE_MCP_STATE_DIR: join(directory, "discovery"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: require("electron") as string,
    args: [join(root, "electron/main.mjs")],
    cwd: root,
    env,
  });
  try {
    const page = await application.firstWindow();
    await application.evaluate(
      "globalThis.__name = function (target) { return target; };",
    );
    const metadata = await application.evaluate(
      async (
        { app, BrowserWindow, ipcMain, screen, powerMonitor },
        fixture,
      ) => {
        const state = { errors: [] as string[], calls: [] as string[] };
        (globalThis as any).foregroundNetSuite = state;
        for (const channel of [
          "orvane:netsuite-tabs",
          "orvane:netsuite-run",
          "orvane:netsuite-open-record",
        ])
          ipcMain.removeHandler(channel);
        ipcMain.handle("orvane:netsuite-tabs", () => [
          { id: "fixture", label: "Fixture", status: "ready", count: 1 },
        ]);
        ipcMain.handle("orvane:netsuite-open-record", () => {
          throw Error("External record navigation is outside the fixture.");
        });
        ipcMain.handle(
          "orvane:netsuite-run",
          (_event, _environment: string, op: string, args: any = {}) => {
            state.calls.push(op);
            if (op === "scripts")
              return {
                rows: Array.from({ length: fixture.scripts }, (_, i) => ({
                  id: i + 1,
                  name: `Script ${i}`,
                  scriptfile: `script-${i}.js`,
                  fileid: i + 1,
                  owner: "Fixture",
                  scriptid: `customscript_${i}`,
                  scripttype: "UserEvent",
                })),
              };
            if (op === "folders")
              return {
                rows: Array.from({ length: 1000 }, (_, i) => ({
                  id: i + 1,
                  name: `Folder ${i}`,
                  parent: null,
                })),
              };
            if (op === "folder")
              return {
                folders: [],
                files: [
                  {
                    id: 42,
                    name: "fixture.js",
                    filetype: "JAVASCRIPT",
                    filesize: 100000,
                  },
                ],
              };
            if (op === "file")
              return {
                id: args.id,
                name: "fixture.js",
                filetype: "JAVASCRIPT",
                binary: false,
                content: "// Electron fixture\n".repeat(5000),
                base64: "",
              };
            if (op === "tables" || op === "table-detail")
              return { rows: [], columns: [] };
            if (op === "query")
              return {
                rows: Array.from({ length: 100 }, (_, i) => ({
                  id: i,
                  memo: "fixture query data ".repeat(50),
                })),
                totalCount: 100,
                offset: 0,
              };
            if (op === "deployments")
              return {
                rows: Array.from({ length: 1000 }, (_, i) => ({
                  primarykey: i + 1,
                  scriptid: `customdeploy_${i}`,
                  status: "Released",
                  recordtype: "Customer",
                  isdeployed: true,
                  loglevel: "DEBUG",
                })),
              };
            state.errors.push(op);
            throw Error(`Unsupported Electron fixture operation: ${op}`);
          },
        );
        const window = BrowserWindow.getAllWindows()[0]!;
        const display = screen.getDisplayMatching(window.getBounds());
        const width = Math.min(1440, display.workArea.width - 40),
          height = Math.min(1000, display.workArea.height - 80);
        window.setContentSize(width, height);
        window.setPosition(display.workArea.x + 10, display.workArea.y + 10);
        window.focus();
        const preferences = window.webContents.getLastWebPreferences();
        return {
          versions: process.versions,
          display: {
            bounds: display.bounds,
            workArea: display.workArea,
            scaleFactor: display.scaleFactor,
            refreshRate: display.displayFrequency,
          },
          contentSize: { width, height },
          gpu: await app.getGPUInfo("basic"),
          gpuFeatures: app.getGPUFeatureStatus(),
          onBatteryPower: powerMonitor.isOnBatteryPower(),
          webPreferences: {
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration,
            sandbox: preferences.sandbox,
            webviewTag: preferences.webviewTag,
          },
          profileIsolated: true,
        };
      },
      fixture,
    );
    await page.locator('main[data-ready="true"]').waitFor();
    await page.locator('main[data-saved="true"]').waitFor();
    return {
      application,
      page: page as Page,
      context: application.context() as BrowserContext,
      metadata,
      async focus() {
        for (let attempt = 0; attempt < 3; attempt++) {
          const focused = await application.evaluate(
            ({ app, BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows()[0]!;
              if (window.isMinimized()) window.restore();
              window.show();
              app.focus({ steal: true });
              window.focus();
              return window.isFocused();
            },
          );
          if (focused) return;
          await page.waitForTimeout(300);
        }
        throw Error(
          "Electron window is not foreground and visible before sampling.",
        );
      },
      async renderedMetadata() {
        Object.assign(
          metadata,
          await application.evaluate(
            async ({ app, BrowserWindow, powerMonitor }) => {
              const window = BrowserWindow.getAllWindows()[0]!;
              return {
                gpu: await app.getGPUInfo("basic"),
                gpuComplete: await app
                  .getGPUInfo("complete")
                  .catch((error) => ({ error: String(error) })),
                hardwareAccelerationEnabled:
                  app.isHardwareAccelerationEnabled(),
                onBatteryPower: powerMonitor.isOnBatteryPower(),
                windowBounds: window.getBounds(),
                commandSwitches: {
                  disableGpu: app.commandLine.hasSwitch("disable-gpu"),
                  disableGpuCompositing: app.commandLine.hasSwitch(
                    "disable-gpu-compositing",
                  ),
                },
              };
            },
          ),
        );
      },
      async resources() {
        // Electron MemoryInfo reports kilobytes. Keep processes separate:
        // working sets can include shared pages and are not additive RAM use.
        return application.evaluate(({ app }) =>
          app.getAppMetrics().map(({ type, memory }) => ({ type, memory })),
        );
      },
      async validate() {
        const state = await application.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          return {
            ...(globalThis as any).foregroundNetSuite,
            focused: window.isFocused(),
            visible: window.isVisible(),
            minimized: window.isMinimized(),
          };
        });
        if (state.errors.length)
          throw Error(
            `Unexpected Electron IPC operations: ${state.errors.join(", ")}`,
          );
        if (!state.focused || !state.visible || state.minimized)
          throw Error(
            `Electron window is not foreground and visible: ${JSON.stringify({ focused: state.focused, visible: state.visible, minimized: state.minimized })}`,
          );
        return state;
      },
      async close() {
        if (!page.isClosed())
          await page
            .locator('main[data-saved="true"]')
            .waitFor({ timeout: 5000 })
            .catch(() => {});
        await application.close();
      },
    };
  } catch (error) {
    await application.close();
    throw error;
  }
}
