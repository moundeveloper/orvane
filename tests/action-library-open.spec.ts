import { expect, test } from "./fixtures";
import { emptyWorkspace } from "../src/model";

// Workspace options → Action library always responds at once: the library
// can take seconds to load the first time, so a loading notice shows until
// it opens.
test("Action library opens from Workspace options, with feedback while it loads", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, emptyWorkspace());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Action library" }).click();
  const library = page.getByRole("region", { name: "Workspace action library" });
  // Either it is already loaded, or the notice shows right away.
  await expect(library.or(page.getByRole("status").filter({ hasText: "Opening Action library" }))).toBeVisible({ timeout: 1000 });
  await expect(library).toBeVisible({ timeout: 60_000 });
});
