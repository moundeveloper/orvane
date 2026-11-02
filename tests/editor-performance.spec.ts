import { test, expect } from "./fixtures";

for (const kind of ["code", "sql"] as const) {
  for (const size of [1000, 500_000]) {
    test(`${kind} editor serializes once per edit with ${size} characters`, async ({
      page,
    }, info) => {
      await page.goto("/");
      const stats = await page.evaluate(
        async ({ kind, size }) => {
          const module = "/tests/editor-performance-harness.ts";
          const fixture = (await import(module)).mountEditorFixture(kind, size);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          fixture.reset();
          await fixture.edit();
          const stats = fixture.stats;
          fixture.unmount();
          return stats;
        },
        { kind, size },
      );
      console.log("Editor serializes once per edit:", kind, size, stats);
      await info.attach(`${kind}-${size}.json`, {
        body: JSON.stringify(stats),
        contentType: "application/json",
      });
      expect(stats.updates).toBe(10);
      expect(stats.calls).toBe(10);
    });
  }
}

async function mount(
  page: import("@playwright/test").Page,
  kind: "code" | "sql",
  normalize = false,
) {
  await page.goto("/");
  const initial = await page.evaluate(
    async ({ kind, normalize }) => {
      const module = "/tests/editor-performance-harness.ts";
      const fixture = (await import(module)).mountEditorFixture(
        kind,
        1000,
        normalize,
      );
      (window as any).editorFixture = fixture;
      return fixture.text;
    },
    { kind, normalize },
  );
  return { root: page.locator("#editor-fixture"), initial };
}

for (const kind of ["code", "sql"] as const) {
  test(`${kind} editor accepts external replacements and keeps immediate input, undo and redo`, async ({
    page,
  }) => {
    const { root, initial } = await mount(page, kind);
    await page.evaluate(async () => {
      const fixture = (window as any).editorFixture;
      fixture.reset();
      await fixture.edit(1);
    });
    expect(await page.evaluate(() => (window as any).editorFixture.text)).toBe(
      initial + "z",
    );
    expect(
      await page.evaluate(() => (window as any).editorFixture.stats),
    ).toEqual({ calls: 1, characters: initial.length + 1, updates: 1 });
    const content = root.locator(".cm-content");
    await content.click();
    await page.keyboard.press("Control+z");
    await expect
      .poll(() => page.evaluate(() => (window as any).editorFixture.text))
      .toBe(initial);
    await page.keyboard.press("Control+y");
    await expect
      .poll(() => page.evaluate(() => (window as any).editorFixture.text))
      .toBe(initial + "z");
    const external = kind === "sql" ? "SELECT 2" : "const external = 2;";
    await page.evaluate(async (value) => {
      await (window as any).editorFixture.replace(value);
    }, external);
    expect(
      await page.evaluate(() => (window as any).editorFixture.docText),
    ).toBe(external);
    await page.evaluate(async () => {
      const fixture = (window as any).editorFixture;
      fixture.reset();
      await fixture.edit(1);
    });
    expect(await page.evaluate(() => (window as any).editorFixture.text)).toBe(
      external + "z",
    );
    expect(
      await page.evaluate(() => (window as any).editorFixture.stats.updates),
    ).toBe(1);
    await page.evaluate(() => (window as any).editorFixture.unmount());
  });

  test(`${kind} editor applies parent normalization without dropping text or looping`, async ({
    page,
  }) => {
    const { initial } = await mount(page, kind, true);
    await page.evaluate(async () => {
      const fixture = (window as any).editorFixture;
      fixture.reset();
      await fixture.edit(1);
    });
    expect(await page.evaluate(() => (window as any).editorFixture.text)).toBe(
      initial.toUpperCase() + "Z",
    );
    expect(
      await page.evaluate(() => (window as any).editorFixture.docText),
    ).toBe(initial.toUpperCase() + "Z");
    expect(
      await page.evaluate(() => (window as any).editorFixture.stats.updates),
    ).toBe(2);
    await page.evaluate(async () => {
      const fixture = (window as any).editorFixture;
      fixture.reset();
      await fixture.edit(1);
    });
    expect(await page.evaluate(() => (window as any).editorFixture.text)).toBe(
      initial.toUpperCase() + "ZZ",
    );
    expect(
      await page.evaluate(() => (window as any).editorFixture.stats.updates),
    ).toBe(2);
    await page.evaluate(() => (window as any).editorFixture.unmount());
  });

  test(`${kind} editor keeps composition input intact and does not serialize selection changes`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { root, initial } = await mount(page, kind);
    await root.locator(".cm-content").click();
    await page.evaluate(() => (window as any).editorFixture.reset());
    await page.keyboard.press("Control+End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Control+End");
    expect(
      await page.evaluate(() => (window as any).editorFixture.stats.calls),
    ).toBe(0);
    const session = await page.context().newCDPSession(page);
    await session.send("Input.imeSetComposition", {
      text: "漢",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await session.send("Input.imeSetComposition", {
      text: "漢字",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await session.send("Input.insertText", { text: "漢字" });
    await expect
      .poll(() => page.evaluate(() => (window as any).editorFixture.text))
      .toBe(initial + "漢字");
    expect(
      await page.evaluate(() => (window as any).editorFixture.docText),
    ).toBe(initial + "漢字");
    await session.detach();
    await page.evaluate(() => (window as any).editorFixture.unmount());
    expect(errors).toEqual([]);
  });
}

test("SuiteQL echo tracking follows document identity without losing independent undo histories", async ({
  page,
}) => {
  const { root, initial } = await mount(page, "sql");
  await page.evaluate(async () => {
    await (window as any).editorFixture.edit(1);
  });
  await page.evaluate(async () => {
    await (window as any).editorFixture.switchDoc("b", "SELECT 2");
  });
  await page.evaluate(async () => {
    await (window as any).editorFixture.edit(1);
  });
  await page.evaluate(async (value) => {
    await (window as any).editorFixture.switchDoc("a", value);
  }, initial + "z");
  await root.locator(".cm-content").click();
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => page.evaluate(() => (window as any).editorFixture.text))
    .toBe(initial);
  await page.keyboard.press("Control+y");
  await expect
    .poll(() => page.evaluate(() => (window as any).editorFixture.text))
    .toBe(initial + "z");
  await page.evaluate(async () => {
    await (window as any).editorFixture.switchDoc("b", "SELECT 2z");
  });
  await root.locator(".cm-content").click();
  await page.keyboard.press("Control+z");
  await expect
    .poll(() => page.evaluate(() => (window as any).editorFixture.text))
    .toBe("SELECT 2");
  await page.evaluate(() => (window as any).editorFixture.unmount());
});
