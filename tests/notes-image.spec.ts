import { expect, test } from "./fixtures";
import { emptyWorkspace, makeBlock } from "../src/model";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxXQAAAAASUVORK5CYII=";

test("Notes stores multiline image captions and exposes image drag and copy", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const timestamp = "2026-11-19";
  let blocks = [
    {
      id: "picture",
      pageId: "a",
      type: "image",
      html: png,
      indent: 0,
      position: 0,
      caption: "",
      imageWidth: 20,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "todo",
      pageId: "a",
      type: "todo",
      html: "One line",
      indent: 0,
      position: 1,
      caption: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  await page.route("**/__orvane/notes/data", async (route) => {
    const args = route.request().postDataJSON();
    if (args.action === "replaceBlocks") blocks = args.rows;
    if (args.action === "put" && args.collection === "blocks") {
      blocks = blocks.map(
        (block) =>
          args.rows.find((row: { id: string }) => row.id === block.id) ?? block,
      );
    }
    await route.fulfill({
      json:
        args.action !== "list"
          ? {}
          : args.collection === "blocks"
            ? blocks
            : [
                {
                  id: "a",
                  title: "Pictures",
                  type: "page",
                  parentId: null,
                  icon: null,
                  position: 0,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
    });
  });
  const workspace = emptyWorkspace();
  const notes = makeBlock("notes");
  notes.value = JSON.stringify({ active: "a", tabs: ["a"] });
  workspace.apps.push({
    id: "notes-app",
    name: "Notes fixture",
    icon: "text",
    x: 120,
    y: 180,
    width: 800,
    height: 620,
    blocks: [notes],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 12,
    gap: 12,
    radius: 8,
  });
  await page.addInitScript((data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, workspace);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const caption = page.getByPlaceholder("Add a caption…");
  await caption.fill("First line\nSecond line");
  await expect(caption).toHaveValue("First line\nSecond line");
  await caption.blur();
  await expect.poll(() => blocks[0]?.caption).toBe("First line\nSecond line");
  const image = page.locator(".blk-image img");
  const dragged = await image.evaluate((element) => {
    const transfer = new DataTransfer();
    element.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }),
    );
    const data = transfer.getData("application/x-orvane-notes-image");
    document.querySelector(".canvas-background")?.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: 1120,
        clientY: 600,
      }),
    );
    return data;
  });
  expect(JSON.parse(dragged)).toEqual({ value: png, name: "First line" });
  await expect(
    page.locator('.image-widget img[alt="First line"]'),
  ).toBeVisible();
  await expect(image).toBeVisible();
  await image.click({ button: "right" });
  const copy = page.getByRole("button", { name: "Copy image", exact: true });
  await expect(copy).toBeFocused();
  await copy.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.clipboard.read()).flatMap((item) => item.types),
      ),
    )
    .toContain("image/png");
  const todo = page.locator(".type-todo .block-content");
  await todo.click();
  await todo.press("End");
  await todo.press("Control+x");
  await expect(todo).toBeEmpty();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "One line",
  );
  await expect
    .poll(() => blocks.find((block) => block.id === "todo")?.html)
    .toBe("");
  expect(
    await todo.evaluate((block) => ({
      offset: window.getSelection()?.focusOffset,
      placeholderPosition: getComputedStyle(block, "::before").position,
    })),
  ).toEqual({ offset: 0, placeholderPosition: "absolute" });
  await page.evaluate(() =>
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.ctrlKey && event.key === "q")
          document.body.dataset.ctrlQReachedWindow = "true";
      },
      { once: true },
    ),
  );
  await todo.dispatchEvent("keydown", {
    key: "q",
    ctrlKey: true,
    bubbles: true,
  });
  await expect(page.locator("body")).toHaveAttribute(
    "data-ctrl-q-reached-window",
    "true",
  );
});
