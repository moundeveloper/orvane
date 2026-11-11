import { test, expect } from "./fixtures";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
test("desktop tool installer preserves existing tools and hooks and runs idempotently", async ({}, info) => {
  test.skip(process.platform !== "win32", "Windows desktop installer");
  const dir = info.outputPath("profile"),
    config = join(dir, ".claude.json"),
    desktop = join(dir, "claude_desktop_config.json"),
    settings = join(dir, "settings.json");
  await mkdir(dir, { recursive: true });
  const netSuiteEntry = {
    command: process.execPath,
    args: [join(process.cwd(), "server", "launch.mjs")],
    env: {
      ORVANE_MCP_PROFILE: "netsuite",
      ORVANE_DATA_DIR: join(process.cwd(), ".orvane"),
    },
  };
  const legacyEntry = {
    ...netSuiteEntry,
    env: {
      ...netSuiteEntry.env,
      ORVANE_MCP_PROFILE: "exposition",
      ORVANE_CLAUDE_PROJECTS_DIR: join(dir, "projects"),
    },
  };
  const servers = {
    orvane: netSuiteEntry,
    "orvane-exposition": legacyEntry,
    existing: { command: "existing-node", args: ["existing.mjs"] },
  };
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: servers,
      theme: "keep",
    }),
  );
  await writeFile(desktop, JSON.stringify({ mcpServers: servers }));
  await writeFile(
    settings,
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "existing-hook" }] },
        ],
      },
      permissions: { defaultMode: "plan" },
    }),
  );
  const args = [
    "-NoProfile",
    "-File",
    join(process.cwd(), "scripts/install-orvane-exposition.ps1"),
    "-ConfigDirectory",
    dir,
    "-McpConfig",
    config,
    "-DesktopConfig",
    desktop,
  ];
  await promisify(execFile)("pwsh", args, { windowsHide: true });
  await promisify(execFile)("pwsh", args, { windowsHide: true });
  const mcp = JSON.parse(await readFile(config, "utf8")),
    desktopMcp = JSON.parse(await readFile(desktop, "utf8")),
    saved = JSON.parse(await readFile(settings, "utf8"));
  expect(mcp.theme).toBe("keep");
  expect(mcp.mcpServers.existing.command).toBe("existing-node");
  expect(mcp.mcpServers["orvane-exposition"]).toBeUndefined();
  expect(mcp.mcpServers.orvane).toEqual({
    ...netSuiteEntry,
    env: { ...legacyEntry.env, ORVANE_MCP_PROFILE: "desktop" },
  });
  expect(desktopMcp.mcpServers).toEqual(mcp.mcpServers);
  expect(saved.permissions.defaultMode).toBe("plan");
  expect(saved.hooks.SessionStart).toHaveLength(2);
  expect(saved.hooks.SessionStart[0].hooks[0].command).toBe("existing-hook");
  expect(
    await readFile(join(dir, "skills/orvane-exposition/SKILL.md"), "utf8"),
  ).toContain("exposition_show");
});
