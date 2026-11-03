import type { Page } from "@playwright/test";
import { join } from "node:path";

export async function captureElectronPanAppearance(
  page: Page,
  directory: string,
  options = { name: "electron", deltaX: 0, deltaY: -75 },
) {
  const before = await page.evaluate(() => {
    const matrix = new DOMMatrix(
      getComputedStyle(document.querySelector(".canvas-plane")!).transform,
    );
    return {
      x: matrix.e,
      y: matrix.f,
      scale:
        document
          .querySelector<HTMLElement>(".canvas-app")!
          .getBoundingClientRect().width /
        document.querySelector<HTMLElement>(".canvas-app")!.offsetWidth,
      blur: getComputedStyle(document.querySelector(".topbar-frost")!)
        .backdropFilter,
    };
  });
  const anchor = await page.evaluate(() => {
    for (let y = 120; y < innerHeight - 100; y += 12)
      for (let x = 18; x < innerWidth - 100; x += 12) {
        const el = document.elementFromPoint(x, y);
        if (
          el?.closest("main") &&
          !el.closest(
            ".canvas-app,.spatial-group,.topbar,.dock,.floating-panel",
          )
        )
          return { x, y };
      }
    throw Error("No visible canvas gap for the visual probe.");
  });
  await page.mouse.move(anchor.x, anchor.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(anchor.x + options.deltaX, anchor.y + options.deltaY, {
    steps: 8,
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const during = await page.evaluate(() => ({
    cursor: getComputedStyle(document.querySelector(".pan-cursor-surface")!)
      .cursor,
    blur: getComputedStyle(document.querySelector(".topbar-frost")!)
      .backdropFilter,
  }));
  await page.screenshot({
    path: join(directory, `${options.name}-active-pan.png`),
  });
  await page.mouse.move(anchor.x, anchor.y, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const after = await page.evaluate(() => {
    const matrix = new DOMMatrix(
      getComputedStyle(document.querySelector(".canvas-plane")!).transform,
    );
    return {
      x: matrix.e,
      y: matrix.f,
      scale:
        document
          .querySelector<HTMLElement>(".canvas-app")!
          .getBoundingClientRect().width /
        document.querySelector<HTMLElement>(".canvas-app")!.offsetWidth,
      blur: getComputedStyle(document.querySelector(".topbar-frost")!)
        .backdropFilter,
      pointerEvents: getComputedStyle(
        document.querySelector(".pan-cursor-surface")!,
      ).pointerEvents,
    };
  });
  await page.screenshot({
    path: join(directory, `${options.name}-restored-pan.png`),
  });
  if (
    during.cursor !== "grabbing" ||
    during.blur !== before.blur ||
    after.blur !== before.blur ||
    after.pointerEvents !== "none" ||
    Math.abs(after.x - before.x) > 0.001 ||
    Math.abs(after.y - before.y) > 0.001 ||
    after.scale !== before.scale
  )
    throw Error("Electron pan appearance/restore check failed.");
  return {
    before,
    during,
    after,
    note: "Active-gesture and restored snapshots, not evidence of physical frame presentation.",
  };
}

export async function captureOverviewAppearance(
  page: Page,
  directory: string,
  variant: string,
) {
  const pan = await captureElectronPanAppearance(page, directory, {
    name: `${variant}-overview`,
    deltaX: 37.35,
    deltaY: -22.65,
  });
  await page
    .locator(".dock-tab")
    .filter({ hasText: /^notes 0$/ })
    .click();
  await page.waitForFunction(() => {
    const app = document.querySelector<HTMLElement>('[data-app-id="app-0"]')!;
    return (
      app.getBoundingClientRect().width / app.offsetWidth > 0.5 &&
      !document.querySelector(".canvas-plane.camera-moving")
    );
  });
  await page.waitForTimeout(300);
  const returned = await page.evaluate(() => {
    const app = document.querySelector<HTMLElement>('[data-app-id="app-0"]')!;
    return {
      scale: app.getBoundingClientRect().width / app.offsetWidth,
      willChange: getComputedStyle(document.querySelector(".canvas-plane")!)
        .willChange,
      blur: getComputedStyle(document.querySelector(".topbar-frost")!)
        .backdropFilter,
    };
  });
  if (
    returned.scale <= 0.5 ||
    returned.willChange !== "auto" ||
    returned.blur !== pan.before.blur
  )
    throw Error("Overview cache did not clear on return to Notes.");
  await page.screenshot({
    path: join(directory, `${variant}-overview-return-notes.png`),
  });
  return { pan, returned };
}

export async function measureElectronFirstUse(page: Page, screenshot: string) {
  await page.evaluate(() => {
    const state = ((window as any).coldValidity = {
      stop: false,
      invalid: false,
      frames: 0,
      blur: 0,
    });
    (window as any).coldBlur = () => state.blur++;
    addEventListener("blur", (window as any).coldBlur);
    const check = () => {
      state.frames++;
      if (!document.hasFocus() || document.hidden) state.invalid = true;
      if (!state.stop) requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  const measure = async (
    root: string,
    action: import("@playwright/test").Locator,
    ready: string,
    text = "",
    fit = false,
  ) => {
    await page.evaluate(
      ({ root, ready, text, fit }) => {
        const w = window as any;
        w.coldMeasurement = null;
        let start: number | undefined;
        const clicked = () => {
          start = performance.now();
          document.removeEventListener("click", clicked, true);
        };
        document.addEventListener("click", clicked, true);
        const observer = new MutationObserver(() => {
          const scope = document.querySelector(root);
          const target = scope?.querySelector(ready);
          const bounds = target?.getBoundingClientRect();
          const fits =
            !fit ||
            (!!bounds &&
              bounds.left >= 0 &&
              bounds.right <= innerWidth + 1 &&
              bounds.top >= 40 &&
              bounds.bottom <= innerHeight - 40 &&
              !document.querySelector(".canvas-plane.camera-moving"));
          if (
            start !== undefined &&
            target &&
            target.getClientRects().length &&
            (target.textContent || "").includes(text) &&
            fits
          ) {
            observer.disconnect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                w.coldMeasurement = performance.now() - start!;
              }),
            );
          }
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
        w.cancelColdMeasurement = () => {
          observer.disconnect();
          document.removeEventListener("click", clicked, true);
        };
      },
      { root, ready, text, fit },
    );
    try {
      await action.click();
      await page.waitForFunction(
        () => (window as any).coldMeasurement !== null,
        undefined,
        { timeout: 10000 },
      );
      return await page.evaluate(
        () => (window as any).coldMeasurement as number,
      );
    } finally {
      await page.evaluate(() => (window as any).cancelColdMeasurement());
    }
  };
  const net = '[data-app-id="app-12"]';
  const projects = '[data-app-id="app-42"]';
  const ns = page.locator(net),
    hub = page.locator(projects);
  try {
    const netFitMs = await measure(
      "main",
      page.locator(".dock-tab").filter({ hasText: /^netsuite 12$/ }),
      net,
      "",
      true,
    );
    const hiddenBefore = {
      files: await ns.locator(".fc-workspace").count(),
      query: await ns.locator(".ns-query-view").count(),
    };
    if (hiddenBefore.files || hiddenBefore.query)
      throw Error("Cold panes initialized before first selection.");
    const fileColdMs = await measure(
      net,
      ns.getByRole("tab", { name: "File Cabinet", exact: true }),
      ".fc-workspace .cm-content",
      "// Electron fixture",
    );
    const queryColdMs = await measure(
      net,
      ns.getByRole("tab", { name: "SuiteQL", exact: true }),
      ".ns-query-view .cm-editor",
    );
    const fileWarmMs = await measure(
      net,
      ns.getByRole("tab", { name: "File Cabinet", exact: true }),
      ".fc-workspace .cm-content",
      "// Electron fixture",
    );
    const queryWarmMs = await measure(
      net,
      ns.getByRole("tab", { name: "SuiteQL", exact: true }),
      ".ns-query-view .cm-editor",
    );
    await ns
      .getByRole("button", { name: "Run query", exact: true })
      .first()
      .click();
    await ns.locator(".ns-result-row").first().waitFor();
    await ns.getByRole("tab", { name: "Scripts", exact: true }).click();
    await ns.locator(".script-row").first().click();
    await page.waitForFunction(
      (root) =>
        document.querySelector(root)!.querySelectorAll(".ns-deployment")
          .length === 100,
      net,
    );
    await ns.getByRole("tab", { name: "SuiteQL", exact: true }).click();
    await ns.locator(".ns-result-row").first().waitFor();
    const projectsFitMs = await measure(
      "main",
      page.locator(".dock-tab").filter({ hasText: /^projects 42$/ }),
      projects,
      "",
      true,
    );
    const terminalsBefore = await hub.locator(".xterm").count();
    const terminalColdMs = await measure(
      projects,
      hub.locator(".terminal-tab").nth(1),
      ".terminal-host:nth-child(2) .xterm",
    );
    const terminalsAfterCold = await hub.locator(".xterm").count();
    const terminalWarmMs = await measure(
      projects,
      hub.locator(".terminal-tab").first(),
      ".terminal-host:first-child .xterm",
    );
    const terminalsAfterWarm = await hub.locator(".xterm").count();
    if (
      terminalsBefore !== 1 ||
      terminalsAfterCold !== 2 ||
      terminalsAfterWarm !== 2
    )
      throw Error("Terminal first-use ownership changed.");
    await hub.locator(".terminal-host:visible textarea").focus();
    await page.keyboard.type("fixture-output");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (root) =>
        [
          ...document
            .querySelector(root)!
            .querySelectorAll<HTMLElement>(".terminal-host"),
        ].some(
          (el) =>
            el.getClientRects().length &&
            el.textContent?.includes("Controlled fixture output"),
        ),
      projects,
      { timeout: 10000 },
    );
    await page.screenshot({ path: screenshot });
    const validity = await page.evaluate(() => {
      const w = window as any;
      w.coldValidity.stop = true;
      removeEventListener("blur", w.coldBlur);
      return w.coldValidity;
    });
    if (validity.invalid || validity.blur)
      throw Error(`Interrupted first-use run: ${JSON.stringify(validity)}`);
    return {
      netFitMs,
      projectsFitMs,
      fileColdMs,
      fileWarmMs,
      queryColdMs,
      queryWarmMs,
      terminalColdMs,
      terminalWarmMs,
      hiddenBefore,
      terminalsBefore,
      terminalsAfterCold,
      terminalsAfterWarm,
      retainedQueryOutput: true,
      expandedDeploymentRows: 100,
      controlledTerminalOutput: true,
      validity,
    };
  } finally {
    await page.evaluate(() => {
      const w = window as any;
      w.coldValidity.stop = true;
      removeEventListener("blur", w.coldBlur);
    });
  }
}
