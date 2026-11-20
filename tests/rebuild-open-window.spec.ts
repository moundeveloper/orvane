import { test, expect, _electron as electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// A second Orvane (or a test) started from the same folder rebuilds dist when
// sources changed. A window that is already open must keep loading its
// on-demand parts (Action library graph, Custom tools) afterwards.
test("an open window keeps working when another Orvane rebuilds", async ({}, info) => {
  test.setTimeout(400_000);
  const data = info.outputPath("data");
  const env = {
    ...(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5240", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 120_000 });

    // Change a part the window loads on demand (new hashed file names), then
    // let another server rebuild; the change is undone afterwards.
    const changed = resolve("src/components/CustomToolsPanel.vue");
    const original = readFileSync(changed, "utf8");
    writeFileSync(changed, original.replace(".tools-head h2 {", ".tools-head h2 { letter-spacing: 0.01px;"));
    await new Promise<void>((done, fail) => {
      const other = spawn(process.execPath, ["electron/server.mjs", "5241"], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      const timer = setTimeout(() => (other.kill(), fail(Error(`No rebuild: ${output}`))), 300_000);
      other.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("5241")) {
          clearTimeout(timer);
          other.kill();
          done();
        }
      });
      other.stderr.on("data", (chunk) => (output += chunk));
    }).finally(() => writeFileSync(changed, original));

    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Action library" }).click();
    const library = page.getByRole("region", { name: "Workspace action library" });
    await expect(library).toBeVisible({ timeout: 30_000 });
    await library.getByRole("button", { name: "New action" }).click();
    await expect(library.locator(".vue-flow")).toBeVisible({ timeout: 30_000 });
    await library.getByRole("button", { name: "Close action library" }).click();
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Custom tools", exact: true }).click();
    await expect(page.getByRole("region", { name: "Custom tools" })).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close();
  }
});
