import { _electron as electron, expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { UiMakerService } from "../server/uimaker";

test("UI Maker MCP opens views and adds only approved references", async ({}, info) => {
  test.setTimeout(120_000);
  const data = info.outputPath("data");
  const service = new UiMakerService(data);
  const { id } = await service.createFolder("Prompt");
  await service.saveState({ components: [{ id, name: "Prompt", width: 480, height: 360 }], notes: [], strokes: [], tweaks: [] });
  await service.deliver(id, "<!doctype html><main>Review copy</main>", "Review copy");
  const round = await service.labStart(id, "Context layouts", "new");
  await service.labWrite(id, { round: round.round, variant: "context-row", label: "Context Row", html: "<!doctype html><main>Lab variant</main>" });
  await service.close();

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
  };
  const desktop = await electron.launch({
    args: ["electron/main.mjs"],
    env: { ...env, ORVANE_PORT: "5256", ORVANE_USER_DATA: info.outputPath("profile") },
  });
  const client = new Client({ name: "uimaker-open-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: { ...env, ORVANE_MCP_PORT: "0", ORVANE_MCP_ORIGINS: "http://localhost:5256" },
    stderr: "pipe",
  });
  const raw = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    if (result.isError) throw Error(JSON.stringify(result.content));
    const content = result.content[0];
    if (content?.type !== "text") throw Error(`Expected a text result from ${name}`);
    return result.structuredContent?.result ?? JSON.parse(content.text);
  };
  try {
    const page = await desktop.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60_000 });
    await page.evaluate(() => localStorage.setItem("orvane-uimaker-seen", "1"));
    await client.connect(transport);
    await expect.poll(async () => (await call("workspace_status")).sessions.length, { timeout: 30_000 }).toBe(1);
    const appId = "test-uimaker";
    await call("workspace_batch", {
      commands: [
        { operation: "app_create", args: { id: appId, properties: { name: "UI Maker", width: 1150, height: 720, padding: 0 } } },
        { operation: "component_create", args: { appId, kind: "uimaker", properties: { sizing: "fill" } } },
      ],
    });
    const editor = page.locator(".uimaker");
    const modes = editor.locator(".editor-controls .pills");

    expect(await call("uimaker_open", { component: id, appId, mode: "inspect" })).toMatchObject({ appId, component: id, mode: "inspect", version: 2 });
    await expect(modes.getByRole("button", { name: "Inspect", exact: true })).toHaveClass(/\bon\b/);
    await expect(editor.frameLocator('iframe[title="Component"]').getByText("Review copy")).toBeVisible();
    expect((await raw("uimaker_open", { component: id, version: 99 })).isError).toBe(true);

    expect(await call("uimaker_open", { component: id, mode: "lab", appId })).toMatchObject({ appId, component: id, mode: "lab" });
    await expect(editor.getByRole("tab", { name: "Context Row" })).toBeVisible();
    await expect(editor.frameLocator('iframe[title="Context Row"]').getByText("Lab variant")).toBeVisible();

    expect(await call("uimaker_open", { component: id, mode: "review", version: 1 })).toMatchObject({ component: id, mode: "review", version: 1 });
    await expect(modes.getByRole("button", { name: "Review", exact: true })).toHaveClass(/\bon\b/);
    await expect(editor.locator('iframe[title="Component"]')).toHaveAttribute("src", /\/v1\/index\.html/);

    const reference = info.outputPath("reference.png");
    await writeFile(reference, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2QAAAAASUVORK5CYII=", "base64"));
    expect((await raw("uimaker_reference_add", { component: id, path: "relative.png" })).isError).toBe(true);
    expect(await call("uimaker_reference_add", { component: id, path: reference, caption: "Composer reference", appId })).toMatchObject({ appId, component: id, mode: "review", version: 2, referenceAdded: true });
    await expect(editor.locator('[data-caption]')).toContainText("Composer reference");
    const saved = new UiMakerService(data);
    try {
      expect(saved.component(id).refs).toEqual([expect.objectContaining({ caption: "Composer reference", file: expect.stringMatching(/\.png$/) })]);

      const propose = (candidates: { source: string; title: string }[], replaces?: string) => ({
        component: id, appId, replaces, candidates: candidates.map(candidate => ({ ...candidate, path: reference })),
      });
      const source = "https://www.pinterest.com/pin/101/";
      const first = await call("uimaker_reference_propose", propose([{ source, title: "First option" }]));
      expect(first).toMatchObject({ appId, status: "pending" });
      const review = editor.getByRole("dialog", { name: "Review visual references" });
      await expect(review).toBeVisible();
      await expect(review.getByRole("button", { name: "Add selected" })).toBeDisabled();
      await review.getByRole("textbox", { name: "Feedback for alternatives" }).fill("Lighter glass");
      await review.getByRole("button", { name: "Reject and find others" }).click();
      const status = (reviewId: string) => call("uimaker_reference_review_status", { component: id, appId, id: reviewId });
      expect(await status(first.id)).toMatchObject({ status: "alternatives-requested", feedback: "Lighter glass", exclude: [source] });
      expect(saved.component(id).refs).toHaveLength(1);
      const repeated = propose([{ title: "Same Pin", source: "https://it.pinterest.com/pin/101/?tracking=1" }], first.id);
      expect((await raw("uimaker_reference_propose", repeated)).isError).toBe(true);

      const approvedSource = "https://www.pinterest.com/pin/102/";
      const second = await call("uimaker_reference_propose", propose([
        { title: "Lighter glass", source: approvedSource },
        { title: "Clear edges", source: "https://www.pinterest.com/pin/103/" },
      ], first.id));
      await expect(review).toBeVisible();
      const approved = review.getByRole("button", { name: "Lighter glass", exact: true });
      await expect.poll(() => approved.locator("img").evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      await approved.click();
      // A click outside the review leaves it open.
      await review.page().mouse.click(4, 4);
      await expect(review).toBeVisible();
      await expect(approved).toHaveAttribute("aria-pressed", "true");
      // Space peeks a candidate full window: zoom, pan, arrows, select.
      const page = review.page();
      await approved.press("Space");
      const peek = page.getByRole("dialog", { name: "Peek: Lighter glass" });
      await expect(peek).toBeVisible();
      await expect(peek.getByText("1 / 2")).toBeVisible();
      const image = peek.locator("img");
      await expect(image).toBeVisible();
      const transform = () => image.evaluate(el => (el as HTMLElement).style.transform);
      const fitted = await transform();
      const box = (await image.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -400);
      await expect.poll(transform).not.toBe(fitted);
      const zoomed = await image.boundingBox();
      expect(zoomed!.width).toBeGreaterThan(box.width * 1.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 4 });
      await page.mouse.up();
      expect((await image.boundingBox())!.x).toBeGreaterThan(zoomed!.x + 100);
      await page.screenshot({ path: info.outputPath("reference-peek.png") });
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("dialog", { name: "Peek: Clear edges" })).toBeVisible();
      await expect(page.getByText("2 / 2")).toBeVisible();
      const select = page.getByRole("button", { name: "Select", exact: true });
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Selected", exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Enter");
      await expect(select).toHaveAttribute("aria-pressed", "false");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: /^Peek:/ })).toHaveCount(0);
      await expect(review).toBeVisible();
      await approved.focus();
      await approved.press("Escape");
      await expect(review).toBeHidden();
      expect(await status(second.id)).toMatchObject({ status: "pending" });
      await editor.getByRole("button", { name: "Review references", exact: true }).click();
      await expect(approved).toHaveAttribute("aria-pressed", "true");
      await review.getByRole("button", { name: "Add selected (1)", exact: true }).click();
      await expect.poll(() => status(second.id)).toMatchObject({ status: "accepted", selected: [approvedSource] });
      expect(saved.component(id).refs?.map(item => item.caption)).toEqual(["Composer reference", `Lighter glass · ${approvedSource}`]);
    } finally {
      await saved.close();
    }
  } finally {
    await client.close().catch(() => undefined);
    await desktop.close();
  }
});
