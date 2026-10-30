import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";

// Sites that refuse framing (like NetSuite) must still load in the desktop
// Browser app, with real history and links opening as tabs.
test("Desktop Browser app loads frame-blocking sites in a webview", async ({}, info) => {
  test.setTimeout(120000);
  const site = createServer((request, response) => {
    const name = (request.url || "/").slice(1) || "home";
    response.setHeader("content-type", "text/html");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("content-security-policy", "frame-ancestors 'none'");
    response.end(
      `<!doctype html><title>Fixture ${name}</title><h1>${name}</h1>` +
        `<a id="tab" href="/two" target="_blank">two</a><div style="height:4000px"></div>`,
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5199",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
    // No menu bar, and Alt (used for Alt+drag) can't bring it up.
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isMenuBarVisible() || w.isMenuBarAutoHide()),
      ),
    ).toEqual([false]);
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page
      .getByRole("button", { name: "Create Browser", exact: true })
      .click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    await addressBar.fill(`${origin}/one`);
    await addressBar.focus();
    // Plain key press: locator.press can wait on the embedded page's navigation.
    await page.keyboard.press("Enter");
    const tabs = browser.locator(".browser-tab");
    await expect(tabs.first()).toContainText("Fixture one", {
      timeout: 15000,
    });

    // A middle click opens an ordinary link in a background Browser tab.
    await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find(c => c.getType() === "webview")!;
      const pos = await guest.executeJavaScript(`(() => { const a = document.querySelector('#tab'); a.removeAttribute('target'); const r = a.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      guest.sendInputEvent({ type: 'mouseDown', button: 'middle', clickCount: 1, ...pos });
      guest.sendInputEvent({ type: 'mouseUp', button: 'middle', clickCount: 1, ...pos });
    });
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText("Fixture two", { timeout: 15000 });
    await tabs.nth(1).getByRole('button').click();
    await expect(tabs).toHaveCount(1);

    // Right click invokes the guest page's native context menu.
    const contextMenu = await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find(c => c.getType() === 'webview')!;
      const event = new Promise<boolean>(resolve => { guest.once('context-menu', () => resolve(true)); setTimeout(() => resolve(false), 3000); });
      guest.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, x: 20, y: 20 });
      guest.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, x: 20, y: 20 });
      return event;
    });
    expect(contextMenu).toBe(true);
    await page.keyboard.press('Escape');

    // Processing pages are compact, share the browser session and can close.
    await browser.getByRole('button', { name: 'Use current tab' }).click();
    const processing = browser.locator('.processing-list');
    await expect(processing).toContainText('ready', { timeout: 15000 });
    await processing.getByRole('button', { name: 'Close' }).click();
    await expect(processing).toContainText('No processing tabs');
    await browser.getByRole('button', { name: /Processing tabs/ }).click();

    // Real history from the page itself.
    await addressBar.fill(`${origin}/three`);
    // Submit without a key press: once the page takes focus and navigates,
    // even a plain key press can stall waiting on it (flaky here).
    await addressBar.evaluate((input) => (input as HTMLInputElement).form!.requestSubmit());
    await expect(tabs.first()).toContainText("Fixture three");
    await browser.getByRole("button", { name: "Back", exact: true }).click();
    await expect(tabs.first()).toContainText("Fixture one");
    await expect(addressBar).toHaveValue(`${origin}/one`);

    // A target=_blank link inside the page opens as a Browser tab.
    await app.evaluate(async ({ webContents }) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getType() === "webview");
      await guest!.executeJavaScript("document.getElementById('tab').click()", true);
    });
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toContainText("Fixture two", { timeout: 15000 });

    // Guests are isolated: no Node, own session.
    const guest = await app.evaluate(({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((c) => c.getType() === "webview")!;
      return contents.executeJavaScript("typeof require + ' ' + typeof process");
    });
    expect(guest).toBe("undefined undefined");

    // Pages see a plain Chrome user agent (Akamai blocks Electron's).
    const agent = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .find((c) => c.getType() === "webview")!
        .executeJavaScript("navigator.userAgent"),
    );
    expect(agent).toContain("Chrome/");
    expect(agent).not.toMatch(/Electron|orvane/i);

    // Canvas zoom: the active page renders at on-screen pixel density
    // (sharp) while keeping the same CSS layout width.
    const guestMetrics = () =>
      app.evaluate(async ({ webContents }) => {
        const guests = webContents
          .getAllWebContents()
          .filter((c) => c.getType() === "webview");
        const guest = guests.sort((a, b) => b.id - a.id)[0]!;
        return guest.executeJavaScript(
          "({ dpr: devicePixelRatio, width: innerWidth })",
        ) as Promise<{ dpr: number; width: number }>;
      });
    const hostDpr = await page.evaluate(() => devicePixelRatio);
    const flat = await guestMetrics();
    await page.mouse.move(700, 450);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    const box = page.locator(".browser-page");
    const zoom = () =>
      box.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
    await expect.poll(zoom).toBeGreaterThan(1.2);
    await expect
      .poll(async () => {
        const [scale, metrics] = [await zoom(), await guestMetrics()];
        return (
          Math.abs(metrics.dpr - hostDpr * scale) < 0.05 * hostDpr &&
          Math.abs(metrics.width - flat.width) <= 2
        );
      }, { timeout: 10000 })
      .toBe(true);

    // A window.open popup is not affected by the canvas zoom.
    const popupZoom = await app.evaluate(async ({ webContents, BrowserWindow }) => {
      const guests = webContents
        .getAllWebContents()
        .filter((c) => c.getType() === "webview");
      const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      await guests.sort((a, b) => b.id - a.id)[0]!.executeJavaScript(
        "window.open(location.href, 'pick', 'width=420,height=320'); 1",
        true,
      );
      let popup: Electron.BrowserWindow | undefined;
      for (let i = 0; i < 50 && !popup; i++) {
        await new Promise((done) => setTimeout(done, 100));
        popup = BrowserWindow.getAllWindows().find((w) => !before.has(w.id));
      }
      if (!popup) return -1;
      await new Promise((done) => setTimeout(done, 500));
      const factor = popup.webContents.getZoomFactor();
      popup.close();
      return factor;
    });
    expect(popupZoom).toBe(1);

    // Clicking elsewhere and coming back: the page still scrolls, and canvas
    // gestures made over it (Ctrl+wheel, middle-drag) move the canvas.
    const guestScroll = () =>
      app.evaluate(async ({ webContents }) => {
        const guests = webContents
          .getAllWebContents()
          .filter((c) => c.getType() === "webview");
        return guests.sort((a, b) => b.id - a.id)[0]!.executeJavaScript("scrollY") as Promise<number>;
      });
    const zoomedIn = await zoom();
    await page.mouse.move(700, 450);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 700);
    await page.keyboard.up("Control");
    await expect.poll(zoom).toBeLessThan(zoomedIn * 0.5);
    await page.locator(".canvas-background").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".browser-shield")).toHaveCount(0);
    const pageBox = async () => (await box.boundingBox())!;
    let b = await pageBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(0, 400);
    await expect.poll(guestScroll).toBeGreaterThan(100);
    const zoomBefore = await zoom();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 300);
    await page.keyboard.up("Control");
    await expect.poll(zoom).toBeLessThan(zoomBefore * 0.9);
    await page.waitForTimeout(600); // let the zoom animation settle
    b = await pageBox();
    const cx = b.x + b.width / 2,
      cy = b.y + b.height / 2;
    // Panning follows the OS cursor; in the test it follows Playwright's
    // virtual mouse, mapped to screen coordinates.
    await app.evaluate(({ screen }) => {
      const g = globalThis as any;
      g.realCursor ??= screen.getCursorScreenPoint.bind(screen);
      screen.getCursorScreenPoint = () => g.fakeCursor ?? g.realCursor();
    });
    const moveTo = async (x: number, y: number) => {
      await app.evaluate(({ BrowserWindow }, p) => {
        const window = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith("http://localhost:5199"),
        )!;
        const bounds = window.getContentBounds();
        (globalThis as any).fakeCursor = {
          x: Math.round(bounds.x + p.x),
          y: Math.round(bounds.y + p.y),
        };
      }, { x, y });
      await page.mouse.move(x, y);
    };
    await moveTo(cx, cy);
    await page.mouse.down({ button: "middle" });
    await page.waitForTimeout(100); // a hand starts moving after pressing
    for (let i = 1; i <= 6; i++) {
      await moveTo(cx - 10 * i, cy - 5 * i);
      await page.waitForTimeout(30);
    }
    await page.mouse.up({ button: "middle" });
    // The canvas follows the pointer (60px drag) without drifting.
    await expect
      .poll(async () => b.x - (await pageBox()).x)
      .toBeGreaterThan(50);
    expect(b.x - (await pageBox()).x).toBeLessThan(70);

    // Middle-click closes a tab.
    const before = await tabs.count();
    await tabs.last().click({ button: "middle" });
    await expect(tabs).toHaveCount(before - 1);
    await page.screenshot({ path: "artifacts/desktop-browser.png" });
  } finally {
    await app.close();
    await new Promise((done) => site.close(done));
    // Quitting stops the dev server the app started.
    await expect
      .poll(() =>
        fetch("http://localhost:5199", { signal: AbortSignal.timeout(1000) }).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
  }
});

test("the server the desktop app started stops even if the app is killed", async ({}, info) => {
  test.setTimeout(120000);
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5196",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  const page = await app.firstWindow({ timeout: 90000 });
  await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
  const up = () =>
    fetch("http://localhost:5196", { signal: AbortSignal.timeout(1000) }).then(
      () => true,
      () => false,
    );
  expect(await up()).toBe(true);
  // app.process() is a launcher; kill the real Electron main process.
  const pid = await app.evaluate(() => process.pid);
  process.kill(pid, "SIGKILL");
  await expect.poll(up, { timeout: 15000 }).toBe(false);
});
// Saved passwords: offered after a sign-in works, encrypted at rest, filled
// only into pages of the same origin, and never sent to Orvane's own window.
test("Desktop Browser saves logins and fills them on the same site only", async ({}, info) => {
  test.setTimeout(150000);
  // Like NetSuite: a strict CSP (no inline styles) and floating labels drawn
  // over the inputs, so clicks land on the label.
  const form = (title: string) =>
    `<!doctype html><title>${title}</title><link rel="stylesheet" href="/s.css">` +
    `<form method="post" action="/session">` +
    `<div class="f"><label for="user">User</label><input id="user" name="user" autocomplete="username"></div>` +
    `<div class="f"><label for="pass">Password</label><input id="pass" name="pass" type="password"></div>` +
    `<button>Sign in</button></form>`;
  const site = createServer((request, response) => {
    if (request.url === "/s.css") {
      response.setHeader("content-type", "text/css");
      response.end(".f{position:relative;margin:8px}label{position:absolute;left:4px;top:2px;font-size:10px}input{padding:14px 4px 4px}");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.setHeader("content-security-policy", "default-src 'self'; style-src 'self'");
    if (request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const ok = new URLSearchParams(body).get("pass") === "s3cret-Pa55";
        if (ok) {
          response.writeHead(303, { location: "/home" });
          response.end();
        } else response.end(form("Wrong password"));
      });
      return;
    }
    response.end(
      request.url === "/home" ? "<!doctype html><title>Home</title><h1>Signed in</h1>" : form("Login"),
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const port = address.port;
  const profile = info.outputPath("profile");
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5198",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: profile,
    },
  });
  const guest = <T>(code: string) =>
    app.evaluate(
      ({ webContents }, code) =>
        webContents
          .getAllWebContents()
          .find((c) => c.getType() === "webview")!
          .executeJavaScript(code, true),
      code,
    ) as Promise<T>;
  /** A real (trusted) click inside the page. */
  const clickIn = (selector: string) =>
    app.evaluate(async ({ webContents }, selector) => {
      const contents = webContents.getAllWebContents().find((c) => c.getType() === "webview")!;
      const r = await contents.executeJavaScript(
        `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x + 5, y: b.y + b.height / 2 }; })()`,
      );
      const point = { x: Math.round(r.x), y: Math.round(r.y) };
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    }, selector);
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    const tabs = browser.locator(".browser-tab");
    const open = async (url: string, title: string) => {
      await addressBar.fill(url);
      await addressBar.focus();
      await page.keyboard.press("Enter");
      await expect(tabs.first()).toContainText(title, { timeout: 15000 });
    };
    // Later visits navigate from the page: a key press in the address bar
    // can stall on the embedded page's load events.
    const visit = async (url: string) => {
      await guest(`location.href = ${JSON.stringify(url)}; 1`);
      await expect.poll(() => guest<string>("location.href + document.readyState")).toBe(`${url}complete`);
    };
    const signIn = (pass: string) =>
      guest(
        `document.querySelector('[name=user]').value = 'ada';` +
          `document.querySelector('[name=pass]').value = ${JSON.stringify(pass)};` +
          `document.querySelector('form').requestSubmit(); 1`,
      );
    const prompt = browser.getByRole("dialog", { name: "Save password" });

    // A failed sign-in (the form comes back) offers nothing.
    await open(`http://127.0.0.1:${port}/login`, "Login");
    await signIn("wrong");
    await expect(tabs.first()).toContainText("Wrong password");
    await page.waitForTimeout(3500);
    await expect(prompt).toHaveCount(0);

    // A working one offers to save; the prompt never holds the password.
    await signIn("s3cret-Pa55");
    await expect(tabs.first()).toContainText("Home");
    await expect(prompt).toContainText("ada", { timeout: 10000 });
    expect(await prompt.textContent()).not.toContain("s3cret");
    await prompt.getByRole("button", { name: "Save" }).click();
    await expect(prompt).toHaveCount(0);

    // Encrypted at rest.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const vault = path.join(profile, "passwords.vault");
    await expect.poll(() => fs.existsSync(vault)).toBe(true);
    const raw = fs.readFileSync(vault);
    expect(raw.includes("s3cret-Pa55")).toBe(false);
    expect(raw.includes("ada")).toBe(false);

    // Clicking into the login form fills it, through the real page events.
    await visit(`http://127.0.0.1:${port}/login`);
    await guest(
      "window.seen = []; document.querySelector('[name=pass]').addEventListener('input', () => seen.push(1)); 1",
    );
    await clickIn("[name=user]");
    await expect
      .poll(() =>
        guest<string>(
          "document.querySelector('[name=user]').value + '/' + document.querySelector('[name=pass]').value",
        ),
      )
      .toBe("ada/s3cret-Pa55");
    expect(await guest<number>("seen.length")).toBeGreaterThan(0);
    // Clicking again shows the suggestion list right under the field, even
    // though the page's CSP forbids inline styles.
    await clickIn("[name=user]");
    await expect
      .poll(() =>
        guest<number>(
          "(() => { const m = document.querySelector('orvane-passwords'); if (!m) return -1; return Math.round(m.getBoundingClientRect().top - document.querySelector('[name=user]').getBoundingClientRect().bottom); })()",
        ),
      )
      .toBe(4);
    // Page scripts see nothing of the password manager.
    expect(await guest<string>("typeof require + ' ' + typeof process")).toBe(
      "undefined undefined",
    );

    // Another origin (same server, different host name) gets nothing.
    await visit(`http://localhost:${port}/login`);
    await clickIn("[name=user]");
    await page.waitForTimeout(1000);
    expect(await guest<string>("document.querySelector('[name=pass]').value")).toBe("");

    // The manager lists sites and usernames, copies, and deletes.
    await browser.getByRole("button", { name: "Saved passwords" }).click();
    const panel = browser.getByRole("region", { name: "Saved passwords" });
    await expect(panel).toContainText(`127.0.0.1:${port}`);
    await expect(panel).toContainText("ada");
    expect(await panel.innerHTML()).not.toContain("s3cret");
    await panel.getByRole("button", { name: "Copy password for ada" }).click();
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe("s3cret-Pa55");
    await app.evaluate(({ clipboard }) => clipboard.clear());
    const remove = panel.getByRole("button", { name: "Delete password for ada" });
    await remove.click();
    await panel.getByRole("button", { name: "Click again to delete" }).click();
    await expect(panel).toContainText("No saved passwords yet");
    // Clicking anywhere else closes it.
    await addressBar.click();
    await expect(panel).toHaveCount(0);

    // The Orvane window can't ask for a password itself.
    const leaked = await page.evaluate(async () => {
      const api = (window as any).orvaneDesktop;
      return Object.keys(api.passwords).join(",");
    });
    expect(leaked).not.toMatch(/reveal|get|fill/);
  } finally {
    await app.close();
    await new Promise((done) => site.close(done));
  }
});

// Iframes inside a page (NetSuite's Setup Manager) keep canvas gestures.
test("Desktop Browser keeps canvas zoom over iframes inside a page", async ({}, info) => {
  test.setTimeout(120000);
  const site = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      request.url === "/inner"
        ? "<!doctype html><body style='margin:0;background:#cde'><p>inner</p></body>"
        : "<!doctype html><title>Outer</title><body style='margin:0'>" +
            "<iframe src='/inner' style='border:0;width:100vw;height:100vh'></iframe></body>",
    );
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: ["electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5194",
      ORVANE_DATA_DIR: data,
      ORVANE_MCP_STATE_DIR: data,
      ORVANE_USER_DATA: info.outputPath("profile"),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    await addressBar.fill(`http://127.0.0.1:${address.port}/`);
    await addressBar.focus();
    await page.keyboard.press("Enter");
    await expect(browser.locator(".browser-tab").first()).toContainText("Outer", {
      timeout: 15000,
    });
    await page.waitForTimeout(1500); // the iframe loads and gets its listener
    const box = page.locator(".browser-page");
    const zoom = () =>
      box.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth);
    const before = await zoom();
    const b = (await box.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    await expect.poll(zoom).toBeGreaterThan(before * 1.2);
  } finally {
    await app.close();
    await new Promise((done) => site.close(done));
  }
});
