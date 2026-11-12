import { test, expect } from "./fixtures";
import { mkdir, writeFile, appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeSessions } from "../server/claude-sessions";
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
    .getByRole("button", { name: "Create Claude sessions", exact: true })
    .click();
  const app = page.locator(".claude-app");
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
    .getByRole("button", { name: "Claude sessions", exact: true })
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
    .getByRole("button", { name: "Claude sessions", exact: true })
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
  let service = new ClaudeSessions(dir, root);
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
    service = new ClaudeSessions(dir, root);
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
  const service = new ClaudeSessions(dataDir, root);
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
      .getByRole("button", { name: "Create Claude sessions", exact: true })
      .click();
    const app = page.locator(".claude-app");
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
      .getByRole("button", { name: "Claude sessions", exact: true })
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
