import { test, expect } from "./fixtures";

test("the step library searches with /, adds with Enter after the selection, drags and keeps favourites", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Action library", exact: true }).click();
  await page.getByRole("button", { name: "New action", exact: true }).click();
  const library = page.getByRole("complementary", { name: "Step library" });
  await expect(library).toBeVisible();
  const nodes = page.locator(".vue-flow__node");
  await expect(nodes).toHaveCount(1);
  // "/" from the board focuses the search; Enter adds after the selected trigger.
  await nodes.first().locator(".node-drag").click();
  await page.locator(".node-stage").press("/");
  const search = library.getByRole("textbox", { name: "Search steps" });
  await expect(search).toBeFocused();
  await search.fill("notice");
  await expect(library.getByRole("listitem")).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("step-library.png") });
  await search.press("Enter");
  await expect(nodes).toHaveCount(2);
  await expect(page.locator(".vue-flow__edge")).toHaveCount(1);
  await expect(page.locator(".action-node strong").last()).toHaveText("Show message");
  // Drag a step onto the board.
  await search.fill("");
  const stage = page.locator(".node-stage");
  const box = (await stage.boundingBox())!;
  await library
    .getByRole("listitem", { name: "Toggle checkbox" })
    .dragTo(stage, { targetPosition: { x: 80, y: box.height - 60 } });
  await expect(nodes).toHaveCount(3);
  // Favourites are remembered and listed first.
  await library.getByRole("button", { name: "Add Go to app to favourites" }).click();
  await expect(library.locator(".sl-group").first()).toContainText("Favourites");
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(library).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(library.locator(".sl-group").first()).toContainText("Favourites1");
  await expect(library.getByRole("button", { name: "Remove Go to app from favourites" }).first()).toBeVisible();
});
