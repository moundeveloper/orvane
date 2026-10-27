import { test, expect } from "@playwright/test";
import { emptyWorkspace, makeBlock, uid, type CanvasApp } from "../src/model";
function fixture() {
  const w = emptyWorkspace();
  const app: CanvasApp = {
    id: uid(),
    name: "Workbench",
    icon: "app",
    x: 100,
    y: 90,
    width: 1140,
    height: 730,
    blocks: [],
    archived: false,
    group: "",
    exposed: false,
    accent: "#6f8998",
    padding: 24,
    gap: 18,
    radius: 8,
  };
  const field = makeBlock("input"),
    list = makeBlock("list"),
    counter = makeBlock("counter"),
    button = makeBlock("button");
  field.label = "New idea";
  field.value = "A connected thought";
  list.label = "Ideas";
  counter.label = "Captured";
  button.label = "Capture";
  button.rules = [
    {
      id: uid(),
      action: "add-item",
      appId: "",
      target: list.id,
      value: "{New idea}",
    },
    { id: uid(), action: "clear", appId: "", target: field.id, value: "" },
  ];
  app.blocks = [field, list, counter, button];
  w.apps = [app];
  return { w, app, field, list, counter, button };
}
async function seed(
  page: import("@playwright/test").Page,
  w: ReturnType<typeof emptyWorkspace>,
) {
  await page.addInitScript((data) => {
    if (window !== window.top) return;
    localStorage.setItem("orvane.examples.v1", "installed");
    if (!localStorage.getItem("orvane.workspace.v1"))
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, w);
  await page.goto("/");
}
async function graph(page: import("@playwright/test").Page, count = 3) {
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page
    .locator(".tree-select")
    .filter({ hasText: /^Capture$/ })
    .click();
  await page
    .getByRole("button", { name: "Expand to graph", exact: true })
    .click();
  await expect(page.locator(".vue-flow__node")).toHaveCount(count);
}

test("app headers drag directly and titles are editable only in Build mode", async ({
  page,
}) => {
  const { w } = fixture();
  await seed(page, w);
  const app = page.locator(".canvas-app");
  await expect(
    app.getByRole("textbox", { name: "App name", exact: true }),
  ).toHaveCount(0);
  const before = (await app.boundingBox())!;
  const camera = await page.locator(".canvas-plane").getAttribute("style");
  const title = (await app.locator(".app-title").boundingBox())!;
  await page.mouse.move(title.x + 25, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(title.x + 110, title.y + title.height / 2 + 45, {
    steps: 8,
  });
  await page.mouse.up();
  const after = (await app.boundingBox())!;
  expect(after.x - before.x).toBeCloseTo(85, 0);
  expect(after.y - before.y).toBeCloseTo(45, 0);
  expect(await page.locator(".canvas-plane").getAttribute("style")).toBe(
    camera,
  );
  await app.getByRole("button", { name: "Build app", exact: true }).click();
  const name = app.getByRole("textbox", { name: "App name", exact: true });
  await name.fill("Renamed in Build");
  await name.selectText();
  expect((await app.boundingBox())!.x).toBe(after.x);
  await app.getByRole("button", { name: "Done", exact: true }).click();
  await expect(name).toHaveCount(0);
  await expect(app.locator(".app-title")).toHaveText("Renamed in Build");
  await page.reload();
  await expect(app.locator(".app-title")).toHaveText("Renamed in Build");
  expect((await app.boundingBox())!.x).toBe(after.x);
});

test("graph entrance starts after nodes are framed and moves smoothly without changing their layout", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Element.prototype.animate;
    const samples: { opacity: number; x: number; viewport: string }[] = [];
    (window as unknown as { graphSamples: typeof samples }).graphSamples =
      samples;
    Element.prototype.animate = function (frames, options) {
      const animation = original.call(this, frames, options);
      if (this.classList.contains("node-workspace")) {
        const start = performance.now();
        const sample = () => {
          const css = getComputedStyle(this);
          samples.push({
            opacity: Number(css.opacity),
            x: new DOMMatrixReadOnly(css.transform).m41,
            viewport:
              this.querySelector(".vue-flow__transformationpane")?.getAttribute(
                "style",
              ) || "",
          });
          if (performance.now() - start < 320) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }
      return animation;
    };
  });
  const { w } = fixture();
  await seed(page, w);
  await graph(page);
  await expect(page.locator(".node-workspace")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { graphSamples: unknown[] }).graphSamples
            .length,
      ),
    )
    .toBeGreaterThan(5);
  await expect(page.locator(".node-workspace")).toHaveCSS("transform", "none");
  const samples = await page.evaluate(
    () =>
      (
        window as unknown as {
          graphSamples: { opacity: number; x: number; viewport: string }[];
        }
      ).graphSamples,
  );
  expect(samples.some((s) => s.opacity < 0.95 && s.x > 0)).toBe(true);
  expect(new Set(samples.map((s) => s.viewport)).size).toBe(1);
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]!.x).toBeLessThanOrEqual(samples[i - 1]!.x + 0.01);
    expect(samples[i]!.opacity).toBeGreaterThanOrEqual(
      samples[i - 1]!.opacity - 0.01,
    );
  }
  await page.screenshot({ path: "artifacts/graph-refined.png" });
});

test("Add node menu closes outside the menu, including graph panning and outer canvas", async ({
  page,
}) => {
  const { w } = fixture();
  await seed(page, w);
  await graph(page);
  const trigger = page.getByRole("button", { name: "Add node", exact: true });
  const menu = page.locator(".node-add-menu");
  await trigger.click();
  await expect(menu).toBeVisible();
  const pane = (await page.locator(".node-stage").boundingBox())!;
  await page.mouse.click(pane.x + 15, pane.y + 15);
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.mouse.click(25, 60);
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await trigger.click();
  await expect(menu).toHaveCount(0);
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu
    .getByRole("button", { name: "Increase counter", exact: true })
    .click();
  await expect(menu).toHaveCount(0);
  await expect(page.locator(".vue-flow__node")).toHaveCount(4);
});

test("custom dropdowns replace every native select and support keyboard and outside dismissal", async ({
  page,
}) => {
  const { w } = fixture();
  await seed(page, w);
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page
    .locator(".tree-select")
    .filter({ hasText: /^Capture$/ })
    .click();
  await expect(page.locator("select")).toHaveCount(0);
  const combo = page
    .getByRole("combobox", { name: "Action", exact: true })
    .first();
  await combo.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.screenshot({ path: "artifacts/custom-options.png" });
  await page
    .getByRole("option", { name: "Toggle checkbox", exact: true })
    .click();
  await expect(combo).toContainText("Toggle checkbox");
  await combo.press("ArrowDown");
  await page.getByRole("listbox").press("Home");
  await page.getByRole("listbox").press("Enter");
  await expect(combo).toContainText("Add item");
  await combo.click();
  await page.mouse.click(20, 60);
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

test("builder panel resizes by drag and keyboard and persists its width", async ({
  page,
}) => {
  const { w } = fixture();
  await seed(page, w);
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  const handle = page.getByRole("separator", { name: "Resize builder panel" }),
    panel = page.getByRole("complementary", { name: "App builder" });
  const before = (await panel.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 135, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(before + 130);
  await handle.press("ArrowLeft");
  const width = (await panel.boundingBox())!.width;
  await page.waitForTimeout(250);
  await page.reload();
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  expect((await panel.boundingBox())!.width).toBeCloseTo(width, 0);
  await page.screenshot({ path: "artifacts/resizable-builder.png" });
});

test("node sockets connect branches; disconnecting a wire changes execution and saved positions survive reload", async ({
  page,
}) => {
  const { w, button } = fixture();
  await seed(page, w);
  await graph(page);
  const addNode = page.locator(
      `.vue-flow__node[data-id="${button.rules[0]!.id}"]`,
    ),
    clearNode = page.locator(
      `.vue-flow__node[data-id="${button.rules[1]!.id}"]`,
    );
  const head = addNode.locator(".node-drag");
  const pos = (await head.boundingBox())!;
  await page.mouse.move(pos.x + 70, pos.y + 15);
  await page.mouse.down();
  await page.mouse.move(pos.x + 70, pos.y + 110, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Add node", exact: true }).click();
  await page
    .locator(".node-add-menu")
    .getByRole("button", { name: "Increase counter", exact: true })
    .click();
  await expect(page.locator(".vue-flow__node")).toHaveCount(4);
  const increment = page.locator(".vue-flow__node").filter({
    has: page.getByRole("strong").filter({ hasText: "Increase counter" }),
  });
  const inc = page
    .locator(".vue-flow__node")
    .filter({ hasText: "Increase counter" })
    .last();
  await inc
    .getByRole("combobox", { name: "Target component", exact: true })
    .click();
  await page.getByRole("option", { name: "Captured", exact: true }).click();
  await inc
    .getByRole("textbox", { name: "Action value", exact: true })
    .fill("1");
  await page.getByRole("button", { name: "Frame", exact: true }).click();
  await page.waitForTimeout(230);
  const from = (await addNode.locator(".source").boundingBox())!,
    to = (await inc.locator(".target").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
  await expect(page.locator(".vue-flow__edge")).toHaveCount(3);
  await page.waitForTimeout(250);
  await clearNode.locator(".target").dblclick();
  await expect(page.locator(".vue-flow__edge")).toHaveCount(2);
  await page.screenshot({ path: "artifacts/spatial-nodes.png" });
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".list-item")).toContainText("A connected thought");
  await expect(page.locator("output")).toHaveText("1");
  await expect(
    page.getByRole("textbox", { name: "New idea", exact: true }),
  ).toHaveValue("A connected thought");
  await page.waitForTimeout(250);
  await page.reload();
  await graph(page, 4);
  await expect(page.locator(".vue-flow__edge")).toHaveCount(2);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("orvane.workspace.v1")!),
  );
  expect(
    stored.apps[0].blocks[3].graph.positions[button.rules[0]!.id].y,
  ).toBeGreaterThan(150);
});

test("CodeMirror edits JavaScript and HTML with line numbers, syntax tokens and expanded editing", async ({
  page,
}) => {
  const { w, app } = fixture();
  const code = makeBlock("code");
  code.code = "<h1>Hello, canvas.</h1>";
  app.blocks = [code];
  await seed(page, w);
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page.locator(".tree-select").filter({ hasText: "Custom code" }).click();
  const editor = page.getByRole("textbox", {
    name: "HTML / CSS / JavaScript",
    exact: true,
  });
  await expect(page.locator(".cm-lineNumbers")).toBeVisible();
  await editor.fill("<h1>A real editor.</h1>");
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "A real editor." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand code editor", exact: true })
    .click();
  await expect(page.locator(".code-workspace .cm-editor")).toBeVisible();
  await page
    .getByRole("textbox", { name: "HTML / CSS / JavaScript", exact: true })
    .fill("<style>h1{color:#58798e}</style>\n<h1>Room to make things.</h1>");
  await page.screenshot({ path: "artifacts/code-editor.png" });
  await page.getByRole("button", { name: "Close expanded editor" }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("textbox", { name: "JavaScript", exact: true })
    .fill("const result = value.trim();\nreturn result.toUpperCase();");
  await expect(page.locator(".cm-lineNumbers")).toBeVisible();
  await page.screenshot({ path: "artifacts/javascript-editor.png" });
});

test("app name releases focus on canvas, other apps and dock without losing the edit", async ({
  page,
}) => {
  const { w } = fixture();
  await seed(page, w);
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  const name = page.getByRole("textbox", { name: "App name", exact: true });
  await name.fill("A name that stays");
  await page.mouse.click(30, 65);
  await expect(name).not.toBeFocused();
  await expect(name).toHaveValue("A name that stays");
  await name.click();
  await page.getByRole("button", { name: "Workspace options" }).click();
  await expect(name).not.toBeFocused();
  await name.click();
  await page.getByRole("button", { name: "Find an app", exact: true }).click();
  await expect(name).not.toBeFocused();
});

test("embedded app scrollbars inherit thin muted styling", async ({ page }) => {
  await page.goto("/");
  const body = page.frameLocator('iframe[title="Calculator"]').locator("body");
  expect(await body.evaluate((el) => getComputedStyle(el).scrollbarColor)).toBe(
    "rgb(184, 203, 214) rgba(0, 0, 0, 0)",
  );
  expect(await body.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe(
    "thin",
  );
});

test("selected nodes form a reusable group with an editable internal graph", async ({
  page,
}) => {
  const { w, button } = fixture();
  await seed(page, w);
  await graph(page);
  const first = page.locator(
      `.vue-flow__node[data-id="${button.rules[0]!.id}"] .node-drag`,
    ),
    second = page.locator(
      `.vue-flow__node[data-id="${button.rules[1]!.id}"] .node-drag`,
    );
  await first.click();
  await page.keyboard.down("Shift");
  await second.click();
  await page.keyboard.up("Shift");
  await expect(page.locator(".vue-flow__node.selected")).toHaveCount(2);
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await expect(page.locator(".vue-flow__node")).toHaveCount(2);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await page.getByRole("button", { name: "Layout", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".list-item")).toContainText("A connected thought");
  await expect(
    page.getByRole("textbox", { name: "New idea", exact: true }),
  ).toHaveValue("");
  await page.getByRole("button", { name: "Build app", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit Capture flow", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open node group", exact: true })
    .click();
  await expect(page.locator(".vue-flow__node")).toHaveCount(3);
  await expect(page.locator(".vue-flow__edge")).toHaveCount(2);
  await page.screenshot({ path: "artifacts/node-group.png" });
  await page.waitForTimeout(250);
  await page.reload();
  await expect(page.locator(".status-area")).toHaveCount(0);
});

test("wheel gestures use a single transform without layout zoom or a settling handoff", async ({
  page,
}) => {
  const { w } = fixture();
  await seed(page, w);
  await page.mouse.move(300, 200);
  await page.keyboard.down("Control");
  const scales = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) => {
        const values: number[] = [];
        let count = 0;
        const tick = () => {
          document.querySelector(".canvas-background")!.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: -20,
              bubbles: true,
              ctrlKey: true,
              clientX: 300,
              clientY: 200,
              cancelable: true,
            }),
          );
          requestAnimationFrame(() => {
            values.push(
              Number(
                (document.querySelector(".canvas-plane") as HTMLElement).style
                  .zoom,
              ),
            );
            if (++count < 6) tick();
            else resolve(values);
          });
        };
        tick();
      }),
  );
  await page.keyboard.up("Control");
  expect(scales.every((value) => value === 0)).toBe(true);
  await expect
    .poll(() =>
      page
        .locator(".canvas-plane")
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a),
    )
    .toBeCloseTo(Math.exp(0.3), 3);
  await expect(page.locator(".camera-zooming")).toHaveCount(0);
});
