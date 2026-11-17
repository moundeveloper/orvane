import { test, expect, _electron as electron } from "@playwright/test";

// Ctrl+W must never close Orvane: Electron's default Window menu bound it to
// "Close", and the hidden menu's shortcuts still fire.
test("Ctrl+W does not close the Orvane window", async ({}, info) => {
  test.setTimeout(120000);
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5198",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
    // No menu item answers Ctrl+W.
    expect(
      await app.evaluate(({ Menu }) => {
        const found: string[] = [];
        const walk = (menu: Electron.Menu | null) => {
          for (const item of menu?.items ?? []) {
            const accelerator = String(item.accelerator ?? item.getDefaultRoleAccelerator?.() ?? "");
            if (/^(CmdOrCtrl|CommandOrControl|Ctrl|Control)\+W$/i.test(accelerator)) found.push(item.label || item.role || "");
            walk(item.submenu ?? null);
          }
        };
        walk(Menu.getApplicationMenu());
        return found;
      }),
    ).toEqual([]);
    // Copy, paste and reload still come from the installed menu.
    expect(
      await app.evaluate(({ Menu }) => ["copy", "paste", "reload"].map((role) =>
        Menu.getApplicationMenu()?.items.some((item) => item.submenu?.items.some((sub) => sub.role === role)))),
    ).toEqual([true, true, true]);
  } finally {
    await app.close().catch(() => undefined);
  }
});
