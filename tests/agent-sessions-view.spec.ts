import { test, expect } from "./fixtures";
import { mkdir, writeFile, appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SessionTranscripts } from "../server/session-transcripts";
import { expositionSchema } from "../src/exposition";
import { mkdirSync, copyFileSync } from "node:fs";
const sessionId = "11111111-1111-4111-8111-111111111111",
  projectPath = "C:/Example/Project";
const line = (uuid: string, type: string, content: unknown) =>
  JSON.stringify({
    uuid,
    type,
    sessionId,
    cwd: projectPath,
    timestamp: "2026-11-06T10:00:00Z",
    message: { content },
  }) + "\n";
const view = () => ({
  id: "lookup",
  title: "Which field is active?",
  status: "illustrative" as const,
  summary: "Two owners, one lookup.",
  sources: [],
  parts: [
    {
      id: "identity",
      type: "identity" as const,
      title: "The owner matters",
      owners: [
        {
          name: "Setup record",
          field: "custrecord_enabled",
          label: "Enabled",
          active: true,
        },
        {
          name: "Script parameter",
          field: "custscript_enabled",
          label: "Enabled",
          active: false,
        },
      ],
    },
  ],
});

test("Claude messages render Markdown safely and modifier-wheel zoom works over the chat", async ({
  page,
  context,
}, info) => {
  test.setTimeout(150000);
  page.setDefaultNavigationTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const cookie = (await context.cookies()).find(
    (c) => c.name === "orvane-test-workspace",
  )!.value;
  const folder = join(
    process.cwd(),
    ".orvane",
    "tests",
    cookie,
    "claude-projects",
    "markdown-fixture",
  );
  await mkdir(folder, { recursive: true });
  const text = [
    "## Why the totals differ",
    "",
    "The **withholding flag** differs on the same `€75.40` line.",
    "",
    "| Field | Staging | Bill |",
    "| --- | --- | --- |",
    "| Amount | €75.40 | €75.40 |",
    "| Withholding | Yes | No |",
    "",
    "1. Match the line.",
    "2. Compare its flags.",
    "",
    "- [x] Amount matches",
    "- [ ] Withholding matches",
    "",
    "> This example shows the difference; it does not modify the bill.",
    "",
    "```js",
    "const withholdingApplies = staging.cas_apply_wh;",
    "if (bill.witaxapplies !== withholdingApplies) review();",
    "```",
    "",
    "[Documentation](https://example.com/docs) · [Unsafe link](javascript:alert(1))",
    "",
    "<script>window.markdownExecuted = true</script>",
    '<img src="https://example.com/tracker" onerror="window.markdownExecuted=true">',
    "",
    "| First column | Second column | Third column | Fourth column | Fifth column | Sixth column |",
    "| --- | --- | --- | --- | --- | --- |",
    "| One | Two | Three | Four | Five | Six |",
    "",
    ...Array.from(
      { length: 20 },
      (_, i) =>
        `Additional context ${i + 1}: the transcript remains unchanged.\n`,
    ),
  ].join("\n");
  await writeFile(
    join(folder, sessionId + ".jsonl"),
    line("md-user", "user", "Show formatted session output") +
      line("md-assistant", "assistant", text),
  );
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Workspace options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create Agent sessions", exact: true })
    .click();
  const app = page.locator(".agent-sessions-app");
  await expect(app).toBeVisible({ timeout: 30000 });
  await app
    .getByRole("button", { name: /Show formatted session output/ })
    .click();
  const message = app.locator(".cs-assistant .chat-markdown");
  await expect(message.locator("table")).toHaveCount(2);
  await expect(
    message.locator("table").first().getByRole("columnheader"),
  ).toHaveText(["Field", "Staging", "Bill"]);
  await expect(message.locator("strong")).toHaveText("withholding flag");
  await expect(message.locator("ol>li")).toHaveCount(2);
  await expect(message.locator("input[type=checkbox]")).toHaveCount(2);
  await expect(message.locator("input[type=checkbox]").first()).toBeDisabled();
  await expect(message.locator("blockquote")).toContainText("does not modify");
  await expect(message.locator("pre code")).toContainText(
    "const withholdingApplies",
  );
  await expect(message.locator("h2")).toHaveText("Why the totals differ");
  expect(await message.locator("script,img,iframe,[onerror]").count()).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { markdownExecuted?: boolean }).markdownExecuted,
    ),
  ).toBeUndefined();
  await expect(
    message.getByRole("link", { name: "Documentation", exact: true }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  expect(
    await message
      .locator("a")
      .filter({ hasText: "Unsafe link" })
      .getAttribute("href"),
  ).toBeNull();
  const chat = app.locator(".cs-chat");
  await chat.evaluate((el) => (el.scrollTop = 0));
  const box = (await chat.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.wheel(0, 250);
  await expect
    .poll(() => chat.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(20);
  const zoom = () =>
    page
      .locator(".canvas-plane")
      .evaluate(
        (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a,
      );
  const initial = await zoom();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 180);
  await page.keyboard.up("Control");
  await expect.poll(zoom).toBeLessThan(initial * 0.9);
  const out = await zoom(),
    newBox = (await chat.boundingBox())!;
  await page.mouse.move(newBox.x + newBox.width / 2, newBox.y + 100);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -160);
  await page.keyboard.up("Control");
  await expect.poll(zoom).toBeGreaterThan(out * 1.1);
  await page
    .getByRole("navigation", { name: "Canvas apps" })
    .getByRole("button", { name: "Agent sessions", exact: true })
    .click();
  await chat.evaluate((el) => (el.scrollTop = 0));
  await app.screenshot({ path: info.outputPath("markdown-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await app.evaluate((el) => {
    const instance = (
      el.closest(".app-surface") as HTMLElement & {
        __vueParentComponent: {
          props: { app: { width: number; height: number } };
        };
      }
    ).__vueParentComponent;
    instance.props.app.width = 360;
    instance.props.app.height = 660;
  });
  await page
    .getByRole("navigation", { name: "Canvas apps" })
    .getByRole("button", { name: "Agent sessions", exact: true })
    .click();
  await chat.evaluate((el) => (el.scrollTop = 0));
  await app.screenshot({ path: info.outputPath("markdown-mobile.png") });
  expect(
    await message.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBe(true);
  expect(errors).toEqual([]);
  const captureDir = join(
    process.cwd(),
    ".impeccable",
    "review",
    "claude-markdown",
  );
  mkdirSync(captureDir, { recursive: true });
  for (const size of ["desktop", "mobile"])
    copyFileSync(
      info.outputPath(`markdown-${size}.png`),
      join(captureDir, `${size}.png`),
    );
});
test("transcript reading handles append fragments, oversized records, exact bindings and persisted revision-safe visuals", async ({}, info) => {
  const dir = info.outputPath("sessions"),
    root = join(dir, "projects"),
    folder = join(root, "C--Example-Project");
  await mkdir(folder, { recursive: true });
  const path = join(folder, sessionId + ".jsonl");
  await writeFile(
    path,
    line("u1", "user", "Explain the two enabled fields") +
      line("a1", "assistant", [
        { type: "text", text: "Here is the distinction." },
        {
          type: "tool_use",
          id: "tool-1",
          name: "mcp__orvane-exposition__exposition_show",
          input: { view: { id: "lookup" } },
        },
      ]),
  );
  let service = new SessionTranscripts(dir, root);
  try {
    const sessions = await service.list();
    expect(sessions).toHaveLength(1);
    const key = sessions[0]!.key;
    let data = await service.read({ key });
    expect(data.messages).toHaveLength(2);
    expect(data.messages[1]!.tools[0]!.visualId).toBe("lookup");
    const bytesBefore = await readFile(path);
    const first = await service.show({
      sessionId,
      projectPath,
      view: view(),
      anchorId: "tool-1",
    });
    expect(first.revision).toBe(1);
    await expect(
      service.show({ sessionId, projectPath, view: view() }),
    ).rejects.toThrow("Current revision: 1");
    await expect(
      service.show({ sessionId, projectPath: "C:/Wrong", view: view() }),
    ).rejects.toThrow("exact Claude");
    await expect(
      service.show({
        sessionId,
        projectPath,
        anchorId: "other-session",
        view: { ...view(), id: "wrong" },
      }),
    ).rejects.toThrow("Anchor");
    expect(
      (
        await service.update({
          sessionId,
          projectPath,
          id: "lookup",
          expectedRevision: 1,
          summary: "Updated locally.",
        })
      ).revision,
    ).toBe(2);
    expect(await readFile(path)).toEqual(bytesBefore);
    const fragment = line("u2", "user", "Partial write");
    await appendFile(path, fragment.slice(0, -8));
    data = await service.read({ key });
    expect(data.messages).toHaveLength(2);
    await appendFile(path, fragment.slice(-8));
    data = await service.read({ key });
    expect(data.messages).toHaveLength(3);
    await appendFile(
      path,
      JSON.stringify({
        type: "user",
        message: { content: "x".repeat(1_100_000) },
      }) +
        "\n" +
        line("a2", "assistant", "After oversized tool output"),
    );
    data = await service.read({ key });
    expect(data.messages.at(-1)!.text).toBe("After oversized tool output");
    expect(data.warnings.join(" ")).toContain("Oversized");
    expect(data.messages.filter((m) => m.id === "u2")).toHaveLength(1);
    const page = await service.read({ key, limit: 2 });
    expect(page.before).toBeTruthy();
    expect(
      (await service.read({ key, before: page.before, limit: 2 })).messages[0]!
        .id,
    ).toBe("u1");
    await expect(service.read({ key: "../../outside" })).rejects.toThrow(
      "Session not found",
    );
    service.close();
    service = new SessionTranscripts(dir, root);
    expect((await service.read({ key })).visuals[0]!.revision).toBe(2);
    await writeFile(path, line("u3", "user", "Replaced transcript"));
    expect((await service.read({ key })).messages.map((m) => m.id)).toEqual([
      "u3",
    ]);
  } finally {
    service.close();
  }
  expect(() =>
    expositionSchema.parse({ ...view(), status: "verified" }),
  ).toThrow();
  expect(() =>
    expositionSchema.parse({
      ...view(),
      parts: [
        {
          id: "alloc",
          title: "Bad allocation",
          type: "allocation",
          total: 10,
          consumed: 5,
          part: 20,
        },
      ],
    }),
  ).toThrow();
});

test("Claude app shows sessions and anchors live visual revisions without mixing conversations", async ({
  page,
  context,
}, info) => {
  test.setTimeout(150000);
  page.setDefaultNavigationTimeout(120000);
  page.on("pageerror", (e) => console.error("Claude UI error:", e.message));
  const cookie = (await context.cookies()).find(
    (c) => c.name === "orvane-test-workspace",
  )!.value;
  const dataDir = join(process.cwd(), ".orvane", "tests", cookie),
    root = join(dataDir, "claude-projects"),
    folder = join(root, "fixture-project");
  await mkdir(folder, { recursive: true });
  const path = join(folder, sessionId + ".jsonl");
  await writeFile(
    path,
    line("u1", "user", "Explain the two enabled fields") +
      line("a1", "assistant", [
        { type: "text", text: "The setup owns the active field." },
        {
          type: "tool_use",
          id: "tool-1",
          name: "mcp__orvane-exposition__exposition_show",
          input: { view: { id: "lookup" } },
        },
      ]),
  );
  const other = "22222222-2222-4222-8222-222222222222";
  await writeFile(
    join(folder, other + ".jsonl"),
    JSON.stringify({
      uuid: "other-user",
      type: "user",
      sessionId: other,
      cwd: projectPath,
      message: { content: "A different conversation" },
    }) + "\n",
  );
  const service = new SessionTranscripts(dataDir, root);
  try {
    await service.show({ sessionId, projectPath, view: view() });
    await page.addInitScript(() =>
      localStorage.setItem("orvane.examples.v1", "installed"),
    );
    await page.goto("/");
    await page
      .getByRole("button", { name: "Workspace options", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create Agent sessions", exact: true })
      .click();
    const app = page.locator(".agent-sessions-app");
    await expect(app).toBeVisible({ timeout: 30000 });
    await app
      .getByRole("button", { name: /Explain the two enabled fields/ })
      .click();
    await expect(app.locator(".cs-message")).toHaveCount(2);
    await expect(app.locator(".cs-assistant .exposition")).toHaveCount(1);
    await expect(app.getByText("custrecord_enabled")).toBeVisible();
    await app.getByLabel("Field present").first().uncheck();
    await expect(app.locator(".ex-result")).toContainText(
      "active field is missing",
    );
    await app.getByRole("button", { name: "Expand", exact: true }).click();
    const originalWidth = await app.evaluate((el) => {
      const surface = el.closest<HTMLElement>(".app-surface")!;
      const { app } = (
        surface as HTMLElement & {
          __vueParentComponent: { props: { app: { width: number } } };
        }
      ).__vueParentComponent.props;
      const original = app.width;
      app.width = 1440;
      return original;
    });
    await expect(
      app.getByRole("region", { name: "Expanded explanation" }),
    ).toBeVisible();
    await expect(app.locator(".cs-chat")).toBeHidden();
    await expect(app.locator(".cs-sidebar")).toBeHidden();
    await page
      .getByRole("navigation", { name: "Canvas apps" })
      .getByRole("button", { name: "Agent sessions", exact: true })
      .click();
    await app
      .getByRole("button", { name: "Back to chat", exact: true })
      .click();
    await expect(app.locator(".cs-chat")).toBeVisible();
    await app.evaluate((el, width) => {
      const surface = el.closest<HTMLElement>(".app-surface")!;
      (
        surface as HTMLElement & {
          __vueParentComponent: { props: { app: { width: number } } };
        }
      ).__vueParentComponent.props.app.width = width;
    }, originalWidth);
    await service.update({
      sessionId,
      projectPath,
      id: "lookup",
      expectedRevision: 1,
      title: "Live explanation update",
    });
    await expect(app.locator(".exposition h3")).toHaveText(
      "Live explanation update",
      { timeout: 10000 },
    );
    await appendFile(path, line("a2", "assistant", "An appended response."));
    await expect(
      app.getByText("An appended response.", { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await app.getByRole("button", { name: /A different conversation/ }).click();
    await expect(app.locator(".exposition")).toHaveCount(0);
    await expect(
      app.getByText("The setup owns the active field.", { exact: true }),
    ).toHaveCount(0);
    await app
      .getByRole("button", { name: /Explain the two enabled fields/ })
      .click();
    await expect(app.locator(".exposition")).toHaveCount(1);
    const source = await stat(path);
    await page.screenshot({
      path: info.outputPath("claude-desktop.png"),
      fullPage: true,
    });
    // At a medium width the long permission hint must not squash Send.
    await app.evaluate((el) => {
      const surface = el.closest<HTMLElement>(".app-surface")! as HTMLElement & {
        __vueParentComponent: { props: { app: { width: number } } };
      };
      surface.__vueParentComponent.props.app.width = 900;
    });
    const send = app.getByRole("button", { name: "Send", exact: true });
    await expect
      .poll(async () => {
        const box = (await send.boundingBox())!;
        return Math.round(box.width - box.height);
      })
      .toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    // The canvas deliberately preserves app geometry on viewport changes.
    // Resize this app itself to exercise the component's narrow layout.
    await app.evaluate((el) => {
      const surface = el.closest<HTMLElement>(".app-surface")!;
      const instance = (
        surface as HTMLElement & {
          __vueParentComponent: {
            props: { app: { width: number; height: number } };
          };
        }
      ).__vueParentComponent;
      instance.props.app.width = 360;
      instance.props.app.height = 660;
    });
    await page
      .getByRole("navigation", { name: "Canvas apps" })
      .getByRole("button", { name: "Agent sessions", exact: true })
      .click();
    await expect(
      app.getByRole("button", { name: "Sessions", exact: true }),
    ).toBeVisible();
    expect(
      await app.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await app.screenshot({ path: info.outputPath("claude-mobile.png") });
    expect((await stat(path)).size).toBe(source.size);
    await service.update({
      sessionId,
      projectPath,
      id: "lookup",
      expectedRevision: 2,
      parts: [
        {
          id: "allocation",
          type: "allocation",
          title: "Capacity versus consumption",
          total: 120000,
          consumed: 10000,
          part: 6000,
          label: "Branch",
        },
        {
          id: "recovery",
          type: "recovery",
          title: "Repair a missing handoff",
          batch: "XML",
          next: "PDF",
          cadence: "15 minutes",
          retriesAvailable: true,
        },
        {
          id: "checks",
          type: "checks",
          title: "Missing prerequisite",
          available: [],
          checks: [
            {
              id: "total",
              name: "Totals",
              requires: [],
              finding: "Illustrative total mismatch",
            },
            {
              id: "number",
              name: "Duplicate number",
              requires: ["protocol"],
              finding: "Illustrative duplicate",
            },
          ],
        },
        {
          id: "flow",
          type: "flow",
          title: "Code ownership",
          nodes: [
            { id: "ui", title: "Admin UI", lines: ["Requests execution"] },
            {
              id: "engine",
              title: "Server engine",
              lines: ["Owns session execution"],
              code: "startSession(agentConfig)",
            },
          ],
          edges: [
            {
              from: "ui",
              to: "engine",
              label: "Start session with the selected agent configuration",
            },
          ],
        },
        {
          id: "sequence",
          type: "sequence",
          title: "Request and reply",
          participants: [
            { id: "ui", name: "UI" },
            { id: "api", name: "API" },
          ],
          messages: [
            { from: "ui", to: "api", label: "Load the profile", reply: false },
            { from: "api", to: "ui", label: "Profile data", reply: true },
            {
              from: "api",
              to: "api",
              label: "Validate internally",
              reply: false,
            },
          ],
        },
        {
          id: "comparison",
          type: "comparison",
          title: "Record mismatch",
          left: "Staging",
          right: "Bill",
          rows: [{ label: "Withholding", left: "Yes", right: "No" }],
        },
      ],
    });
    await expect(app.locator(".ex-part")).toHaveCount(7, { timeout: 10000 });
    await expect(app.locator(".ex-fractions")).toContainText("60%");
    await app
      .getByRole("button", { name: "Run eligible recovery check" })
      .click();
    await expect(
      app.getByText("Recovery applied", { exact: true }),
    ).toBeVisible();
    await app.getByLabel("protocol available", { exact: true }).check();
    await expect(app.getByText("Not evaluated", { exact: true })).toHaveCount(
      0,
    );
    await app
      .getByRole("button", { name: "Load the profile", exact: true })
      .click();
    await expect(app.locator(".ex-message.focused")).toHaveCount(1);
    const paths = await app
      .locator(".ex-flow-wires path")
      .evaluateAll((es) => es.map((e) => e.getAttribute("d") || ""));
    expect(paths.length).toBe(2);
    expect(paths.every((d) => !d.includes("NaN") && !/[CQ]/.test(d))).toBe(
      true,
    );
    expect(
      await app.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await app
      .locator(".ex-part")
      .filter({
        has: page.getByRole("heading", { name: "Code ownership", exact: true }),
      })
      .screenshot({ path: info.outputPath("claude-flow-narrow.png") });
  } finally {
    service.close();
  }
});

test("Agent sessions links named files, opens folders in Orvane and adds @ context", async ({
  page,
  context,
}, info) => {
  test.setTimeout(150000);
  page.setDefaultNavigationTimeout(120000);
  const cookie = (await context.cookies()).find(
    (c) => c.name === "orvane-test-workspace",
  )!.value;
  const root = join(process.cwd(), ".orvane", "tests", cookie);
  const transcripts = join(root, "claude-projects", "links-fixture");
  const project = join(root, "link-project");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(transcripts, { recursive: true });
  await writeFile(join(project, "voxel-guide.md"), "# Guide\n");
  await writeFile(join(project, "src", "Chunk.ts"), "export {};\n");
  const record = (id: string, uuid: string, type: string, content: string) =>
    JSON.stringify({
      uuid,
      type,
      sessionId: id,
      cwd: project,
      timestamp: "2026-11-06T10:00:00Z",
      message: { content },
    }) + "\n";
  // Enough sessions to fill the sidebar, so the search field must hold its
  // height instead of shrinking.
  for (let i = 0; i < 30; i++) {
    const id = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
    await writeFile(
      join(transcripts, id + ".jsonl"),
      record(id, `u${i}`, "user", i ? `Filler session ${i}` : "Write the voxel guide") +
        record(
          id,
          `a${i}`,
          "assistant",
          i
            ? "Done."
            : "Created [voxel-guide.md](voxel-guide.md). Chunks live in `src/Chunk.ts:3`; `missing.ts` was never made. See [the docs](https://example.com/voxels).",
        ),
    );
  }
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "Workspace options", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create Agent sessions", exact: true })
    .click();
  const app = page.locator(".agent-sessions-app");
  await expect(app).toBeVisible({ timeout: 30000 });
  const search = app.locator(".cs-search");
  await expect(app.getByRole("button", { name: /Filler session 9/ })).toBeVisible();
  // A short app with a long list: the field keeps its height.
  await app.evaluate((el) => {
    const instance = (
      el.closest(".app-surface") as HTMLElement & {
        __vueParentComponent: { props: { app: { height: number } } };
      }
    ).__vueParentComponent;
    instance.props.app.height = 420;
  });
  await expect
    .poll(async () =>
      search.evaluate((el) => (el as HTMLElement).offsetHeight),
    )
    .toBe(30);
  await page.evaluate(() => {
    const opened: unknown[] = ((window as any).openedLinks = []);
    window.addEventListener("orvane:open-link", (event) =>
      opened.push((event as CustomEvent).detail.link),
    );
  });
  const opened = () => page.evaluate(() => (window as any).openedLinks);
  await app.getByRole("button", { name: /Write the voxel guide/ }).click();
  const message = app.locator(".cs-assistant .chat-markdown");
  const guide = message.getByRole("link", { name: "voxel-guide.md" });
  await expect(guide).toBeVisible();
  await guide.click();
  await message.getByRole("link", { name: "src/Chunk.ts:3" }).click();
  // Web links go to Orvane's Browser, not straight to the system browser.
  await message.getByRole("link", { name: "the docs" }).click();
  await expect(message.locator("code", { hasText: "missing.ts" })).not.toHaveClass(
    /md-path/,
  );
  await app.getByRole("button", { name: "Open folder", exact: true }).click();
  expect(await opened()).toEqual([
    { kind: "file", target: join(project, "voxel-guide.md"), label: "voxel-guide.md" },
    { kind: "file", target: join(project, "src", "Chunk.ts"), label: "Chunk.ts" },
    { kind: "page", target: "https://example.com/voxels", label: "https://example.com/voxels" },
    { kind: "folder", target: project, label: "link-project" },
  ]);
  const composer = app.getByRole("textbox", { name: "Message", exact: true });
  await composer.click();
  await composer.pressSequentially("Read @");
  const picker = app.getByRole("listbox", { name: "Add context" });
  await expect(picker.getByRole("option", { name: /voxel-guide\.md/ })).toBeVisible();
  await composer.pressSequentially("Chun");
  await expect(picker.getByRole("option", { name: /Chunk\.ts/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("context-picker.png") });
  await composer.press("Tab");
  await expect(picker).toHaveCount(0);
  await expect(composer).toHaveValue("Read ");
  await expect(composer).toBeFocused();
  await expect(app.locator(".cs-attachment")).toHaveAttribute(
    "title",
    join(project, "src", "Chunk.ts"),
  );
  await composer.pressSequentially("@vox");
  await expect(picker.getByRole("option", { name: /voxel-guide\.md/ })).toBeVisible();
  await composer.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(composer).toHaveValue("Read @vox");
  await app.screenshot({ path: info.outputPath("links.png") });
});

test("transcripts keep each tool call's input, result and timing for Claude and Codex", async ({}, info) => {
  const dir = info.outputPath("tool-steps");
  // Claude: tool_use and tool_result arrive as separate records.
  const claudeRoot = join(dir, "projects");
  await mkdir(join(claudeRoot, "C--Example-Project"), { recursive: true });
  const at = (seconds: number) => `2026-11-06T10:00:0${seconds}Z`;
  const record = (uuid: string, type: string, content: unknown, seconds: number) =>
    JSON.stringify({ uuid, type, sessionId, cwd: projectPath, timestamp: at(seconds), message: { content } }) + "\n";
  await writeFile(
    join(claudeRoot, "C--Example-Project", sessionId + ".jsonl"),
    record("u1", "user", "Check the config", 0) +
      record("a1", "assistant", [{ type: "text", text: "Reading it." }], 1) +
      record("a2", "assistant", [{ type: "tool_use", id: "t-read", name: "Read", input: { file_path: "C:/Example/Project/config.json" } }], 1) +
      record("r1", "user", [{ type: "tool_result", tool_use_id: "t-read", content: [{ type: "text", text: '{ "debug": true }' }] }], 3) +
      record("a3", "assistant", [{ type: "tool_use", id: "t-bash", name: "Bash", input: { command: "exit 1" } }], 4) +
      record("r2", "user", [{ type: "tool_result", tool_use_id: "t-bash", content: "Exit code 1", is_error: true }], 5),
  );
  const claude = new SessionTranscripts(dir, claudeRoot);
  try {
    const [session] = await claude.list();
    const { messages } = await claude.read({ key: session!.key });
    // The tool-only records join the reply before them.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.tools).toEqual([
      expect.objectContaining({
        id: "t-read",
        name: "Read",
        input: { file_path: "C:/Example/Project/config.json" },
        output: '{ "debug": true }',
        status: "completed",
        startedAt: Date.parse(at(1)),
        endedAt: Date.parse(at(3)),
      }),
      expect.objectContaining({ id: "t-bash", output: "Exit code 1", status: "failed" }),
    ]);
  } finally {
    claude.close?.();
  }
  // Codex: function calls and their outputs are separate response items.
  const codexRoot = join(dir, "codex");
  const day = join(codexRoot, "2026", "11", "06");
  await mkdir(day, { recursive: true });
  const item = (payload: unknown, seconds: number) =>
    JSON.stringify({ type: "response_item", timestamp: at(seconds), payload }) + "\n";
  await writeFile(
    join(day, "rollout-2026-11-06T10-00-00-" + sessionId + ".jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: projectPath } }) + "\n" +
      JSON.stringify({ type: "event_msg", timestamp: at(0), payload: { type: "user_message", message: "List the files" } }) + "\n" +
      item({ type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["dir"] }) }, 1) +
      item({ type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "config.json", metadata: { exit_code: 0 } }) }, 2) +
      item({ type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: "One file." }] }, 3),
  );
  const codex = new SessionTranscripts(dir, codexRoot, undefined, "codex");
  try {
    const [session] = await codex.list();
    const { messages } = await codex.read({ key: session!.key });
    const call = messages.flatMap((m) => m.tools).find((tool) => tool.id === "c1");
    expect(call).toMatchObject({
      name: "shell",
      input: { command: '[\n  "dir"\n]' },
      output: "config.json",
      status: "completed",
    });
  } finally {
    codex.close?.();
  }
});

// A delegated Codex session that spawns a subagent writes a second rollout
// for that thread; the list shows the session once.
test("Codex subagent threads are not listed as separate sessions", async ({}, info) => {
  const dir = info.outputPath("codex-subagent");
  const day = join(dir, "codex", "2026", "11", "25");
  await mkdir(day, { recursive: true });
  const parent = "01a21415-b513-7312-a898-a651baa688d8",
    child = "01a21417-3e93-74c2-a98a-7bc9923f4bf9";
  await writeFile(
    join(day, `rollout-2026-11-25T20-01-36-${parent}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: parent, cwd: projectPath, source: "exec", thread_source: "user" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Build the mock" } }) + "\n",
  );
  await writeFile(
    join(day, `rollout-2026-11-25T20-03-17-${child}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: child,
        session_id: parent,
        parent_thread_id: parent,
        cwd: projectPath,
        source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } },
        thread_source: "subagent",
      },
    }) + "\n",
  );
  const codex = new SessionTranscripts(dir, join(dir, "codex"), undefined, "codex");
  try {
    const sessions = await codex.list();
    expect(sessions.map((s) => [s.sessionId, s.title])).toEqual([[parent, "Build the mock"]]);
  } finally {
    codex.close?.();
  }
});
