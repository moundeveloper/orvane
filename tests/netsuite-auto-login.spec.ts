import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
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
  const fixture = join(import.meta.dirname, "fixtures", "netsuite-login");
  // Like NetSuite's own: system.netsuite.com posts to enterpriselogin.nl, and
  // the Log In button turns on a moment after both fields are filled.
  const login = (note = "", action = "") =>
    `<!doctype html><title>NetSuite Login</title><script src="/login.js"></script>` +
    `<form id="login-form" method="post"${action && ` action="${action}"`}>` +
    `${note && `<p class="error">${note}</p>`}` +
    `<label for="email">Email</label><input id="email" name="email" type="email">` +
    `<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="off">` +
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
      if (path === "/app/center/card.nl")
        return response.end("<!doctype html><title>NetSuite Home</title><h1>Home</h1>");
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
    await page.locator('main[data-ready="true"]').waitFor({ timeout: 60000 });
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
    const toggle = panel.getByRole("button", { name: `Auto sign-in for ${USER}` });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await addressBar.click();
    await expect(panel).toHaveCount(0);

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
  } finally {
    await app.close();
    await new Promise((done) => site.close(done));
  }
});
