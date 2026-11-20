import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// NetSuite auto sign-in, end to end against a fake NetSuite login page:
// real NetSuite host names are mapped to a local HTTPS server (self-signed,
// test-only certificate), so the origin rules run on the real names.
// No real NetSuite account or credentials are involved.
const USER = "ada@example.test";
const PASS = "fixture-Pa55";

test("Desktop Browser signs in to covered NetSuite login pages by itself", async ({}, info) => {
  test.setTimeout(180000);
  const posts: string[] = [];
  let reject = false;
  let holdCatalog: Promise<void> | undefined;
  let releaseCatalog: (() => void) | undefined;
  let heldCatalogRequests = 0;
  let blockDashboard = false;
  let blockRoleSelector = false;
  // Hosts with a NetSuite session; the others go to the login page.
  const sessions = new Set<string>();
  const fixture = join(import.meta.dirname, "fixtures", "netsuite-login");
  // Like NetSuite's own: system.netsuite.com posts to enterpriselogin.nl, and
  // the Log In button turns on a moment after both fields are filled.
  const login = (note = "", action = "") =>
    `<!doctype html><title>NetSuite Login</title><script src="/login.js"></script>` +
    `<form id="login-form" method="post"${action && ` action="${action}"`}>` +
    `${note && `<p class="error">${note}</p>`}` +
    `<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="off">` +
    `<label for="email">Email</label><input id="email" name="email" type="email" required>` +
    `<button id="login-submit" name="submitButton" type="submit" disabled>Log In</button></form>`;
  const loginScript =
    "addEventListener('input', () => setTimeout(() => {" +
    " const f = document.getElementById('login-form');" +
    " f.submitButton.disabled = !(f.email.value && f.password.value); }, 150));";
  const site = createServer(
    { key: readFileSync(join(fixture, "key.pem")), cert: readFileSync(join(fixture, "cert.pem")) },
    (request, response) => {
      const host = (request.headers.host || "").replace(/:\d+$/, "");
      const path = (request.url || "/").split("?")[0];
      response.setHeader("content-type", "text/html");
      // Like NetSuite: no inline scripts or styles.
      response.setHeader("content-security-policy", "default-src 'self'");
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          // The verification code step.
          if (path === "/app/center/card.nl") {
            sessions.add(host);
            response.writeHead(303, { location: path });
            return response.end();
          }
          posts.push(host);
          const form = new URLSearchParams(body);
          if (reject || form.get("email") !== USER || form.get("password") !== PASS)
            return response.end(login("You have entered an invalid email address or password."));
          // system.netsuite.com hands over to the account's own host; the
          // second sandbox asks for a code from an authenticator app.
          // (Without an account, the user's default one: here 1964539-sb1.)
          const account = new URL(request.url || "/", "https://x").searchParams.get("c") || "1964539_SB1";
          const next =
            host === "system.netsuite.com"
              ? `https://${account.toLowerCase().replace("_", "-")}.app.netsuite.com/app/center/card.nl`
              : host.startsWith("1964539-sb2.")
                ? "/app/login/secure/twofactor.nl"
                : "/app/center/card.nl";
          if (!next.includes("twofactor")) sessions.add(next.startsWith("https://") ? new URL(next).hostname : host);
          response.writeHead(303, { location: next });
          response.end();
        });
        return;
      }
      if (path === "/login.js") {
        response.setHeader("content-type", "text/javascript");
        return response.end(loginScript);
      }
      // Signed out: NetSuite drops the account and shows its generic page.
      if (path === "/signed-out") {
        response.writeHead(302, {
          location: "https://system.netsuite.com/pages/customerlogin.jsp?country=US",
        });
        return response.end();
      }
      if (path === "/pages/customerlogin.jsp")
        return response.end(login("", "/app/login/secure/enterpriselogin.nl"));
      if (path === "/redirect") {
        response.writeHead(302, {
          location: `https://system.netsuite.com.evil.test/app/login/secure/enterpriselogin.nl`,
        });
        return response.end();
      }
      if (path === "/app/center/card.nl") {
        if (blockDashboard && host === "1964539.app.netsuite.com") return;
        if (!sessions.has(host)) {
          response.writeHead(302, { location: "/pages/customerlogin.jsp?country=US" });
          return response.end();
        }
        // Like the dashboard: portlets keep loading after the page itself.
        response.setHeader("Set-Cookie", "fixture-session=active; Secure; HttpOnly; Path=/");
        return response.end(
          "<!doctype html><title>NetSuite Home</title><script src=/n.js></script><h1>Home</h1><iframe src=/portlet></iframe>",
        );
      }
      if (path === "/portlet") return response.end("<!doctype html><p>Portlet</p>");
      if (path === "/app/login/secure/myroles/myroles.nl" && sessions.has(host)) {
        if (blockRoleSelector) return;
        if (!request.headers.cookie?.includes("fixture-session=active")) return response.writeHead(401).end();
        return response.end(`<script type="application/json">${JSON.stringify({
          data: {
            " account": { " accountId": "1964539_SB1", " accountName": "Development" },
            " allAccounts": [{ accountId: "3013", accountName: "Example production", accountType: "PRODUCTION" }],
            " allRoles": [{ entityRoleId: { rol: 3 }, roleName: "Administrator" }],
          },
        })}</script>`);
      }
      // The record catalog (JSON) needs a session, like NetSuite's own.
      if (path === "/app/recordscatalog/rcendpoint.nl") {
        if (!sessions.has(host)) {
          response.writeHead(302, { location: "/pages/customerlogin.jsp?country=US" });
          return response.end();
        }
        response.setHeader("content-type", "application/json");
        const answer = () => response.end(JSON.stringify({ data: [{ id: "customer", label: "Customer" }] }));
        if (holdCatalog) {
          heldCatalogRequests++;
          void holdCatalog.then(answer);
        } else answer();
        return;
      }
      // SuiteScript's loader: N.runtime throws an N.error-like object that
      // structured clone can't copy.
      if (path === "/n.js") {
        response.setHeader("content-type", "text/javascript");
        return response.end(
          "window.require = (names, ok) => ok({ runtime: { getCurrentUser() {" +
            " throw { name: 'SSS_FIXTURE', message: 'Fixture NetSuite error', toJSON() {} }; } } });",
        );
      }
      if (path === "/app/login/secure/twofactor.nl")
        return response.end(
          "<!doctype html><title>Verification</title><form method=post action=/app/center/card.nl>" +
            "<p>Enter the verification code from your authenticator app.</p>" +
            '<input name="code" inputmode="numeric" autocomplete="one-time-code"><button>Submit</button></form>',
        );
      response.end(login());
    },
  );
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address();
  if (!address || typeof address === "string") throw Error("No port");
  const map = ["*.netsuite.com", "*.evil.test", "*.netsuite.co"]
    .map((host) => `MAP ${host} 127.0.0.1:${address.port}`)
    .join(",");
  const profile = info.outputPath("profile");
  const data = info.outputPath("data");
  const app = await electron.launch({
    args: [`--host-resolver-rules=${map}`, "--ignore-certificate-errors", "electron/main.mjs"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== undefined),
      ) as Record<string, string>),
      ORVANE_PORT: "5197",
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
  const where = () => guest<string>("location.href + ' ' + document.readyState");
  const visit = async (url: string, landing = url) => {
    await guest(`location.href = ${JSON.stringify(url)}; 1`);
    await expect.poll(() => guest<string>("document.readyState + ' ' + location.host")).toBe(
      `complete ${new URL(landing).host}`,
    );
  };
  const loginUrl = (host: string, query = "") =>
    `https://${host}/app/login/secure/enterpriselogin.nl${query}`;
  const passwordValue = () => guest<string>("document.querySelector('#password')?.value ?? ''");
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
    const incompleteOrigin = "https://654987.app.netsuite.com";
    const encrypted = await app.evaluate(async ({ safeStorage }, { incompleteOrigin, password }) => {
      const data = await safeStorage.encryptStringAsync(JSON.stringify({
        logins: [{ id: "incomplete", origin: incompleteOrigin, username: "", password,
          scope: "domain", created: Date.now(), updated: Date.now() }],
        never: [],
      }));
      return [...data];
    }, { incompleteOrigin, password: "legacy-fixture-password" });
    writeFileSync(join(profile, "passwords.vault"), Buffer.from(encrypted));
    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("button", { name: "Create Browser", exact: true }).click();
    const browser = page.locator(".browser-view");
    const addressBar = browser.getByRole("textbox", { name: "Address" });
    const tabs = browser.locator(".browser-tab");
    const status = browser.getByRole("status", { name: "NetSuite sign-in" });

    // Nothing saved yet: the user signs in by hand once and saves it.
    await addressBar.fill(loginUrl("1964539-sb1.app.netsuite.com"));
    await addressBar.focus();
    await page.keyboard.press("Enter");
    await expect(tabs.first()).toContainText("NetSuite Login", { timeout: 20000 });
    await page.waitForTimeout(1000);
    expect(posts).toEqual([]);
    const loginPopupUrl = loginUrl("1964539-sb1.app.netsuite.com");
    expect(await guest<boolean>(`!!window.open(${JSON.stringify(loginPopupUrl)}, 'startup-login', 'width=380,height=260')`)).toBe(false);
    await tabs.first().click({ button: "right" });
    await browser.getByRole("menu").getByText("Lock tab to this URL", { exact: true }).click();
    await guest(
      `document.querySelector('#email').value = ${JSON.stringify(USER)};` +
        `document.querySelector('#password').value = ${JSON.stringify(PASS)};` +
        `document.querySelector('form').requestSubmit(); 1`,
    );
    await expect(tabs.first()).toContainText("NetSuite Home");
    const prompt = browser.getByRole("dialog", { name: "Save password" });
    await expect(prompt).toContainText(USER, { timeout: 10000 });
    await prompt.getByRole("button", { name: "Save" }).click();
    await expect(prompt).toHaveCount(0);
    posts.length = 0;

    // Auto sign-in is on by default for NetSuite logins.
    await browser.getByRole("button", { name: "Saved passwords" }).click();
    const panel = browser.getByRole("region", { name: "Saved passwords" });
    const incomplete = panel.getByRole("listitem").filter({ hasText: "654987.app.netsuite.com" });
    await expect(incomplete.getByRole("button", { name: /Auto sign-in/ })).toBeDisabled();
    await incomplete.getByRole("button", { name: /Use domain login/ }).click();
    await incomplete.getByRole("button", { name: "Add email" }).click();
    await incomplete.getByRole("textbox", { name: "NetSuite email" }).fill("other@example.test");
    await incomplete.getByRole("button", { name: "Save", exact: true }).click();
    await expect(incomplete).toContainText("other@example.test");
    await expect(incomplete.getByRole("button", { name: /Auto sign-in/ })).toBeEnabled();
    const toggle = panel.getByRole("button", { name: `Auto sign-in for ${USER}` });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await toggle.click();
    await addressBar.click();
    await expect(panel).toHaveCount(0);

    // The locked tab has its own selected saved login and starts at the
    // original login URL even though the last page was the dashboard.
    await tabs.first().click({ button: "right" });
    await browser.getByRole("menu").getByText("Auto-login", { exact: true }).click();
    await browser.getByRole("menu").getByText(USER, { exact: true }).click();
    await expect(page.locator('main[data-saved="true"]')).toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(tabs.first()).toContainText("NetSuite Home", { timeout: 30_000 });
    expect(posts).toEqual(["1964539-sb1.app.netsuite.com"]);
    await tabs.first().click({ button: "right" });
    await browser.getByRole("menu").getByText("Unlock tab", { exact: true }).click();
    await browser.getByRole("button", { name: "Saved passwords" }).click();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await addressBar.click();
    posts.length = 0;

    // Fill and submit: the login page signs in by itself, once.
    await visit(loginUrl("1964539-sb1.app.netsuite.com"));
    await expect.poll(where, { timeout: 15000 }).toContain("/app/center/card.nl");
    expect(posts).toEqual(["1964539-sb1.app.netsuite.com"]);
    // The listed production account and system.netsuite.com with its
    // account parameter are covered too.
    await visit(loginUrl("1964539.app.netsuite.com"));
    await expect.poll(where, { timeout: 15000 }).toContain("/app/center/card.nl");
    await visit(loginUrl("system.netsuite.com", "?c=1964539_SB1"));
    await expect.poll(where, { timeout: 15000 }).toContain(
      "https://1964539-sb1.app.netsuite.com/app/center/card.nl",
    );
    expect(posts).toHaveLength(3);
    await expect(status).toHaveCount(0);
    posts.length = 0;
    // Signed out, NetSuite shows system.netsuite.com without the account:
    // the account the tab was heading to counts.
    await visit(
      "https://1964539-sb1.app.netsuite.com/signed-out",
      "https://system.netsuite.com/pages/customerlogin.jsp?country=US",
    );
    await expect.poll(where, { timeout: 15000 }).toContain(
      "https://1964539-sb1.app.netsuite.com/app/center/card.nl",
    );
    expect(posts).toEqual(["system.netsuite.com"]);
    posts.length = 0;
    // The same generic page on the account's own host.
    await visit("https://1964539-sb1.app.netsuite.com/pages/customerlogin.jsp?country=US");
    await expect.poll(where, { timeout: 15000 }).toContain(
      "https://1964539-sb1.app.netsuite.com/app/center/card.nl",
    );
    expect(posts).toEqual(["1964539-sb1.app.netsuite.com"]);
    posts.length = 0;

    // Origin rejection: lookalike hosts, a redirect away from NetSuite, an
    // account auto sign-in doesn't cover, and system.netsuite.com without
    // an account all get nothing.
    for (const [url, landing] of [
      [loginUrl("system.netsuite.com.evil.test", "?c=1964539_SB1")],
      [loginUrl("1964539-sb1.app.netsuite.co")],
      ["https://1964539-sb1.app.netsuite.com/redirect", loginUrl("system.netsuite.com.evil.test")],
      [loginUrl("7654321.app.netsuite.com")],
      // Right after an account auto sign-in doesn't cover.
      ["https://system.netsuite.com/pages/customerlogin.jsp?country=US"],
    ]) {
      await visit(url!, landing);
      await expect.poll(() => guest<boolean>("!!document.querySelector('#password')")).toBe(true);
      await page.waitForTimeout(1500);
      expect(await passwordValue(), url).toBe("");
    }
    expect(posts).toEqual([]);

    // 2FA hand-off: after submitting, NetSuite asks for a code; Orvane
    // tells the user and fills nothing.
    await visit(loginUrl("1964539-sb2.app.netsuite.com"));
    await expect.poll(where, { timeout: 15000 }).toContain("/app/login/secure/twofactor.nl");
    await expect(status).toContainText("verification code", { timeout: 10000 });
    expect(await guest<string>("document.querySelector('[name=code]').value")).toBe("");
    expect(posts).toEqual(["1964539-sb2.app.netsuite.com"]);
    posts.length = 0;
    // The user enters the code and is signed in.
    await guest("document.querySelector('[name=code]').value = '123456'; document.querySelector('form').requestSubmit(); 1");
    await expect.poll(where, { timeout: 15000 }).toContain("/app/center/card.nl");
    await expect(status).toHaveCount(0);

    // Loop guard: a rejected sign-in brings the login page back; Orvane
    // stops after one try and shows the page to the user.
    reject = true;
    await visit(loginUrl("1964539-sb1.app.netsuite.com"));
    await expect(status).toContainText("Auto sign-in stopped", { timeout: 15000 });
    await expect.poll(() => guest<string>("document.querySelector('.error')?.textContent ?? ''")).toContain(
      "invalid email",
    );
    await page.waitForTimeout(3000);
    expect(posts).toEqual(["1964539-sb1.app.netsuite.com"]);
    // Coming back to the login page in that tab doesn't retry either.
    await visit(loginUrl("1964539-sb1.app.netsuite.com"));
    await page.waitForTimeout(2000);
    expect(posts).toHaveLength(1);
    expect(await passwordValue()).toBe("");
    // A sign-in by hand clears it.
    reject = false;
    await guest(
      `document.querySelector('#email').value = ${JSON.stringify(USER)};` +
        `document.querySelector('#password').value = ${JSON.stringify(PASS)};` +
        `document.querySelector('form').requestSubmit(); 1`,
    );
    await expect.poll(where, { timeout: 15000 }).toContain("/app/center/card.nl");
    await expect(status).toHaveCount(0);
    posts.length = 0;
    await visit(loginUrl("1964539-sb1.app.netsuite.com"));
    await expect.poll(where, { timeout: 15000 }).toContain("/app/center/card.nl");
    expect(posts).toHaveLength(1);
    posts.length = 0;

    // Turned off: the login page is left alone.
    await browser.getByRole("button", { name: "Saved passwords" }).click();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await addressBar.click();
    await visit(loginUrl("1964539-sb1.app.netsuite.com"));
    await page.waitForTimeout(2000);
    expect(posts).toEqual([]);
    expect(await passwordValue()).toBe("");

    // The flag lives in the encrypted vault: no password or username on disk.
    const raw = readFileSync(join(profile, "passwords.vault"));
    expect(raw.includes(PASS)).toBe(false);
    expect(raw.includes(USER)).toBe(false);
    // The Orvane window still can't ask for a password.
    const api = await page.evaluate(() => Object.keys((window as any).orvaneDesktop.passwords).join(","));
    expect(api).not.toMatch(/reveal|get|fill/);

    // A new tab straight on system.netsuite.com (no account named, none
    // headed to): NetSuite signs in to the default account, so it is allowed.
    await browser.getByRole("button", { name: "Saved passwords" }).click();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await addressBar.click();
    posts.length = 0;
    await browser.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(tabs).toHaveCount(2);
    await addressBar.fill("https://system.netsuite.com/pages/customerlogin.jsp?country=US");
    await addressBar.focus();
    await page.keyboard.press("Enter");
    await expect(tabs.nth(1)).toContainText("NetSuite Home", { timeout: 20000 });
    expect(posts).toEqual(["system.netsuite.com"]);
    posts.length = 0;

    // Processing tabs sign in by themselves too, and say "ready" once done
    // (not "loading" while the dashboard's iframes load).
    await browser.getByRole("button", { name: "Use current tab" }).click();
    const processing = browser.locator(".processing-list");
    const row = processing.locator(".processing-row", { hasText: "1964539-sb1.app.netsuite.com" });
    const processingStatus = () => page.evaluate(async () => {
      const tabs = await (window as any).orvaneDesktop.processing.list();
      return tabs.find(({ origin }: { origin: string }) => origin === "https://1964539-sb1.app.netsuite.com")?.status;
    });
    await expect(row).toContainText("ready", { timeout: 20000 });
    sessions.delete("1964539-sb1.app.netsuite.com");
    await row.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => posts.slice(), { timeout: 20000 }).toEqual(["1964539-sb1.app.netsuite.com"]);
    await expect.poll(processingStatus, { timeout: 20000 }).toBe("ready");
    await page.waitForTimeout(1500);
    expect(await processingStatus()).toBe("ready");
    posts.length = 0;
    // Signed out again while a visible tab is on another account: the
    // processing tab signs in again by itself.
    sessions.add("1964539.app.netsuite.com");
    const newest = () =>
      app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((c) => c.getType() === "webview")
          .sort((a, b) => b.id - a.id)[0]!
          .executeJavaScript("location.href = 'https://1964539.app.netsuite.com/app/center/card.nl'; 1"),
      );
    await newest();
    await expect(tabs.nth(1)).toContainText("NetSuite Home", { timeout: 15000 });
    await expect.poll(() =>
      app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().some((c) => c.getType() === "webview" && c.getURL().startsWith("https://1964539.app.netsuite.com/app/center")),
      ),
    ).toBe(true);
    sessions.delete("1964539-sb1.app.netsuite.com");
    if (!(await processing.isVisible())) await browser.getByRole("button", { name: /Processing tabs/ }).click();
    await row.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => posts.slice(), { timeout: 20000 }).toEqual(["1964539-sb1.app.netsuite.com"]);
    await expect.poll(processingStatus, { timeout: 20000 }).toBe("ready");
    posts.length = 0;
    // NetSuite signs the page out and sends it to system.netsuite.com by
    // itself: the processing page follows and signs back in, untouched.
    sessions.delete("1964539-sb1.app.netsuite.com");
    await app.evaluate(({ webContents }) => {
      const hidden = webContents
        .getAllWebContents()
        .find((c) => c.getType() === "window" && c.getURL().startsWith("https://1964539-sb1.app.netsuite.com/"))!;
      return hidden.executeJavaScript(
        "location.href = 'https://system.netsuite.com/pages/customerlogin.jsp?country=US'; 1",
      );
    });
    await expect.poll(() => posts.slice(), { timeout: 20000 }).toEqual(["system.netsuite.com"]);
    await expect.poll(processingStatus, { timeout: 20000 }).toBe("ready");
    posts.length = 0;

    // NetSuite calls through the processing page.
    const run = (operation: string, args: Record<string, unknown> = {}) =>
      page.evaluate(
        ({ operation, args }) =>
          (window as any).orvaneDesktop.netsuite
            .run("https://1964539-sb1.app.netsuite.com", operation, args)
            .then((value: unknown) => ({ value }), (error: Error) => ({ error: error.message })),
        { operation, args },
      );
    expect(await run("tables")).toEqual({ value: { data: [{ id: "customer", label: "Customer" }] } });
    // A NetSuite error object comes back as its message, not "could not be cloned".
    expect((await run("user")).error).toContain("Fixture NetSuite error");
    // The session ends while the page stays put: the next call signs in
    // again by itself and still answers.
    sessions.delete("1964539-sb1.app.netsuite.com");
    expect(await run("tables")).toEqual({ value: { data: [{ id: "customer", label: "Customer" }] } });
    expect(posts).toEqual(["1964539-sb1.app.netsuite.com"]);
    await expect.poll(processingStatus).toBe("ready");

    if (!(await processing.isVisible())) await browser.getByRole("button", { name: /Processing tabs/ }).click();
    holdCatalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const workingUrl = await addressBar.inputValue();
    const overlapping = Promise.all([run("tables"), run("table-detail", { table: "customer" })]);
    await expect(processing.getByText("Temporary", { exact: false })).toBeVisible({ timeout: 12000 });
    await expect.poll(() => heldCatalogRequests, { timeout: 12000 }).toBe(2);
    expect(await addressBar.inputValue()).toBe(workingUrl);
    await expect(tabs).toHaveCount(2);
    holdCatalog = undefined;
    releaseCatalog?.();
    expect(await overlapping).toEqual([
      { value: { data: [{ id: "customer", label: "Customer" }] } },
      { value: { data: [{ id: "customer", label: "Customer" }] } },
    ]);
    await expect(processing.getByText("Temporary", { exact: false })).toHaveCount(0);

    await browser.getByRole("button", { name: "Saved passwords" }).click();
    const domain = panel.getByRole("button", { name: `Use domain login for ${USER} on netsuite.com` });
    await domain.click();
    await expect(domain).toHaveAttribute("aria-pressed", "true");
    await addressBar.click();
    blockDashboard = true;
    blockRoleSelector = true;
    const menu = browser.getByRole("menu");
    const environmentSwitch = browser.getByRole("button", { name: "Switch NetSuite environment", exact: true });
    await expect(environmentSwitch).toBeVisible();
    await expect(environmentSwitch).toContainText("1964539");
    await environmentSwitch.click();
    await expect(menu.getByText("1964539", { exact: true })).toBeVisible();
    await expect(menu.getByText("NetSuite took too long to respond.", { exact: true })).toBeVisible({ timeout: 12000 });
    blockRoleSelector = false;
    await menu.getByText("Retry environment lookup", { exact: true }).click();
    await expect(menu.getByText("Example production (3013)", { exact: true })).toBeVisible();
    blockDashboard = false;
    await page.screenshot({ path: info.outputPath("browser-netsuite-environments.png") });
    const appEnvironments = await page.evaluate(() => (window as any).orvaneDesktop.netsuite.tabs());
    expect(appEnvironments.map(({ id }: { id: string }) => id)).not.toContain("https://3013.app.netsuite.com");
    await menu.getByText("Example production (3013)", { exact: true }).click();
    await expect.poll(() => sessions.has("3013.app.netsuite.com"), { timeout: 20000 }).toBe(true);
    await expect(addressBar).toHaveValue("https://3013.app.netsuite.com/app/center/card.nl");
    await expect(tabs).toHaveCount(3);
    await browser.getByRole("button", { name: "Saved passwords" }).click();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await addressBar.click();
    await addressBar.fill(loginUrl("3013.app.netsuite.com"));
    await addressBar.press("Enter");
    const loginGuest = (code: string, click = false) =>
      app.evaluate(async ({ webContents }, { code, click }) => {
        const contents = webContents.getAllWebContents().find(c => c.getType() === "webview" && c.getURL().startsWith("https://3013.app.netsuite.com/app/login/"));
        if (!contents) return null;
        const result = await contents.mainFrame.executeJavaScript(code);
        if (click) {
          const point = { x: Math.round(result.x), y: Math.round(result.y) };
          contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
          contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
        }
        return result;
      }, { code, click });
    const rectOf = (selector: string) =>
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 15, y: r.top + 12 }; })()`;
    await expect.poll(() => loginGuest("!!document.querySelector('#email')")).toBe(true);
    await browser.getByRole("button", { name: "Browser menu" }).click();
    await loginGuest(rectOf("#email"), true);
    await expect(menu).toHaveCount(0);
    await expect.poll(() => loginGuest("!!document.querySelector('orvane-passwords')")).toBe(true);
    await loginGuest(`(() => { const r = document.querySelector('orvane-passwords').getBoundingClientRect(); return { x: r.left + 30, y: r.top + 42 }; })()`, true);
    await expect.poll(() => loginGuest("[document.querySelector('#email').value, document.querySelector('#password').value]")).toEqual([USER, PASS]);
  } finally {
    releaseCatalog?.();
    site.closeAllConnections();
    await app.close();
    await new Promise((done) => site.close(done));
  }
});
