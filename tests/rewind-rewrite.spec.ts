import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { emptyWorkspace, makeBlock, type CanvasApp } from "../src/model";
import type { RewindEntry } from "../src/canvasRewind";

const storage = "/__orvane/storage/";
const original =
  "When validation reports a missing record, first you need to import the record before you can deploy.";

function app(id: string, name: string, x: number): CanvasApp {
  return {
    id,
    name,
    x,
    icon: "app",
    y: 140,
    width: 380,
    height: 270,
    blocks: [],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 12,
    gap: 12,
    radius: 8,
  };
}

async function openRewind(page: Page) {
  await page
    .getByRole("button", { name: "Workspace options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Canvas rewind", exact: true })
    .click();
  const history = page.getByRole("region", { name: "Canvas history" });
  const rail = history.getByRole("slider", { name: "Canvas history playhead" });
  await expect
    .poll(async () => Number(await rail.getAttribute("aria-valuemax")))
    .toBeGreaterThan(1);
  return { history, rail };
}

test("rewinds saved canvas arrangements without rolling back app content", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const client = randomUUID();
  const state = emptyWorkspace();
  const note = makeBlock("text");
  note.label = "Original content";
  const before = app("before-app", "Deployment notes", 90);
  before.blocks = [note];
  state.apps.push(before);
  expect(
    (await page.request.post(storage + "lease", { data: { client } })).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.put(storage + "state", {
        data: { client, expectedRevision: 0, data: state },
      })
    ).ok(),
  ).toBeTruthy();
  before.x = 680;
  before.archived = true;
  note.label = "Newer content";
  state.apps.push(app("later-app", "After lunch", 520));
  expect(
    (
      await page.request.put(storage + "state", {
        data: {
          client,
          expectedRevision: 1,
          data: state,
          reason: "Before MCP edit",
        },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await page.request.post(storage + "release", { data: { client } })).ok(),
  ).toBeTruthy();
  const events = (await (
    await page.request.get(storage + "canvas-rewind")
  ).json()) as RewindEntry[];
  expect(events.at(-1)).toMatchObject({ author: "mcp", closed: true });
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await expect(
    page.locator('[data-app-id="later-app"].canvas-app'),
  ).toBeVisible();

  let { history, rail } = await openRewind(page);
  await expect(rail).toBeFocused();
  await rail.press("ArrowLeft");
  await expect(rail).toHaveCSS("outline-style", "none");
  await expect
    .poll(() =>
      rail
        .locator(".rewind-head")
        .evaluate((head) => getComputedStyle(head, "::before").outlineStyle),
    )
    .toBe("solid");
  const track = (await rail.boundingBox())!;
  await page.mouse.move(track.x + 2, track.y + track.height / 2);
  await page.mouse.down();
  await expect(page.locator(".rewind-window.returns")).toBeVisible();
  await page.mouse.move(track.x + track.width - 1, track.y + track.height / 2);
  await page.mouse.up();
  await expect(rail).toHaveAttribute("aria-valuetext", "Live");
  await expect(page.locator(".rewind-window")).toHaveCount(0);
  await rail.press("Home");
  await expect(
    page.getByRole("button", { name: /Deployment notes.*Comes back/ }),
  ).toBeVisible();
  await expect(page.locator(".rewind-window.later")).toContainText(
    "After lunch",
  );
  await page.screenshot({ path: info.outputPath("canvas-rewind.png") });
  await rail.press("Escape");
  await expect(history).toBeHidden();
  await expect(
    page.locator('[data-app-id="later-app"].canvas-app'),
  ).toBeVisible();

  ({ history, rail } = await openRewind(page));
  await rail.press("Home");
  await page
    .getByRole("button", { name: /Deployment notes.*Comes back/ })
    .click();
  await page.keyboard.press("a");
  await expect(history).toBeHidden();
  await expect(page.getByText("Newer content")).toBeVisible();
  await expect(
    page.locator('[data-app-id="later-app"].canvas-app'),
  ).toBeVisible();

  ({ history, rail } = await openRewind(page));
  await rail.press("Home");
  await rail.press("Enter");
  await expect(history).toBeHidden();
  await expect(
    page.locator('[data-app-id="later-app"].canvas-app'),
  ).toBeHidden();
  const after = await (await page.request.get(storage + "state")).json();
  expect(after.data.apps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: before.id,
        x: 90,
        archived: false,
        blocks: [expect.objectContaining({ label: "Newer content" })],
      }),
      expect.objectContaining({ id: "later-app", archived: true }),
    ]),
  );
  await page.reload();
  await expect(page.getByText("Newer content")).toBeVisible();
  await expect(
    page.locator('[data-app-id="later-app"].canvas-app'),
  ).toBeHidden();
});

test("Notes previews a selected rewrite, refines it and applies one undoable edit", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90_000);
  const namespace = (await context.cookies()).find(
    (cookie) => cookie.name === "orvane-test-workspace",
  )!.value;
  const directory = join(process.cwd(), ".orvane", "tests", namespace);
  await mkdir(directory, { recursive: true });
  await copyFile(
    join(process.cwd(), "tests", "helpers", "agent-cli.cjs"),
    join(directory, "agent-cli.cjs"),
  );
  const data = emptyWorkspace();
  const notes = makeBlock("notes");
  notes.value = JSON.stringify({ active: "handbook", tabs: ["handbook"] });
  data.apps.push({
    ...app("notes-app", "Project notes", 120),
    width: 800,
    height: 620,
    blocks: [notes],
  });
  const stamp = "2026-11-22T11:00:00.000Z";
  for (const [collection, rows] of [
    [
      "pages",
      [
        {
          id: "handbook",
          title: "Deploy checklist",
          type: "page",
          parentId: null,
          position: 0,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
    ],
    [
      "blocks",
      [
        {
          id: "line",
          pageId: "handbook",
          type: "paragraph",
          html: `Before. <strong>${original}</strong> After.`,
          position: 0,
          indent: 0,
          caption: "",
          createdAt: stamp,
          updatedAt: stamp,
        },
        {
          id: "other",
          pageId: "handbook",
          type: "paragraph",
          html: "Other text stays here.",
          position: 1,
          indent: 0,
          caption: "",
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
    ],
  ] as const) {
    const response = await page.request.post("/__orvane/notes/data", {
      data: { collection, action: "bulkPut", rows },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  await page.addInitScript((workspace) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    localStorage.setItem("orvane.workspace.v1", JSON.stringify(workspace));
  }, data);
  await page.goto("/");
  const line = page.locator('[data-block-id="line"] .block-content');
  async function selectText() {
    await line.focus();
    await line.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el.querySelector("strong")!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
  }
  await selectText();
  await page.getByRole("button", { name: "Shorten", exact: true }).click();
  const preview = page.getByRole("region", { name: "Rewrite suggestion" });
  await expect(
    preview.getByText("Import the record before deploying."),
  ).toBeVisible();
  await expect(line).toContainText(original);
  await page.screenshot({ path: info.outputPath("notes-rewrite.png") });
  const ask = preview.getByRole("textbox", { name: "Rewrite instruction" });
  await ask.fill("Make it a numbered step");
  await ask.press("Enter");
  await expect(preview.getByText("1. Import the record.")).toBeVisible();
  await preview.getByRole("button", { name: /Replace/ }).click();
  await expect(line).toHaveText("Before. 1. Import the record. After.");
  await expect(page.getByText("Other text stays here.")).toBeVisible();
  await line.press("Control+z");
  await expect(line).toContainText(original);
  await selectText();
  await line.press("Control+/");
  await expect(
    preview.getByText("Import the record before deploying."),
  ).toBeVisible();
  await line.press("Tab");
  await expect(line).toHaveText(
    "Before. Import the record before deploying. After.",
  );
  await page.reload();
  await expect(line).toHaveText(
    "Before. Import the record before deploying. After.",
  );
  const requests = (await readFile(join(directory, "inputs.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((row) => JSON.parse(row));
  expect(JSON.parse(requests[0].message)).toMatchObject({
    selection: original,
  });
  expect(requests[0].args).toEqual(
    expect.arrayContaining([
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
    ]),
  );
  expect(JSON.parse(requests[1].message)).toMatchObject({
    previous: "Import the record before deploying.",
    instruction: "Make it a numbered step",
  });
});
