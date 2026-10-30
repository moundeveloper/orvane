// Runs in every Browser page (sandboxed, in an isolated world that page
// scripts can't see): finds login forms, offers saved logins when the user
// clicks or tabs into one, and reports submitted logins so Orvane can offer
// to save them. The main process decides which logins a page may get from
// the page's real origin; nothing here is trusted for that.
const { ipcRenderer } = require("electron");

if (window.top === window) {
  const shown = (el) =>
    el.isConnected &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const visible = (el) => shown(el) && !el.disabled && !el.readOnly;
  const tokens = (el) => (el.getAttribute("autocomplete") || "").toLowerCase();
  const isNew = (el) => tokens(el).includes("new-password");
  const passwordFields = (scope = document) =>
    [...scope.querySelectorAll('input[type="password"]')].filter(visible);
  const textLike = (el) => ["text", "email", "tel"].includes(el.type) && visible(el);
  function usernameFor(password) {
    const inputs = [...(password.form || document).querySelectorAll("input")];
    const before = inputs.slice(0, inputs.indexOf(password)).filter(textLike);
    return (
      before.find((el) => /username|email/.test(tokens(el))) ?? before[before.length - 1]
    );
  }
  /** The login form on the page: a password field (and its username), or a
   * username-only first step of a two-step sign-in. */
  function loginFields() {
    const password = passwordFields().find((el) => !isNew(el));
    if (password) return { password, username: usernameFor(password) };
    if (passwordFields().length) return;
    const username = [...document.querySelectorAll("input")].find(
      (el) => textLike(el) && tokens(el).split(/\s+/).includes("username"),
    );
    return username && { username };
  }

  // ---- Saved logins for this page ----
  let logins, secure = false, asking;
  function query(hasPassword) {
    asking ??= ipcRenderer
      .invoke("orvane:pw-logins", hasPassword)
      .then((result) => {
        logins = Array.isArray(result?.logins) ? result.logins : [];
        secure = result?.secure === true;
      })
      .catch(() => (logins = []))
      .finally(() => (asking = undefined));
    return asking;
  }
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ).set;
  function setValue(el, value) {
    // The isolated world's own setter: frameworks that track value changes
    // (React…) still see this as a user edit through the events below.
    valueSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function fill(id) {
    hide();
    const login = await ipcRenderer.invoke("orvane:pw-fill", id).catch(() => undefined);
    const fields = loginFields();
    if (!login || !fields) return;
    if (fields.username && login.username) setValue(fields.username, login.username);
    if (fields.password) setValue(fields.password, login.password);
    filled = fields.password ?? fields.username;
  }
  let filled;

  // ---- Suggestions under the field (closed shadow root: the page can't
  // read or click into it; only real clicks count) ----
  let menu;
  function hide() {
    menu?.host.remove();
    menu = undefined;
  }
  function show(field) {
    hide();
    const host = document.createElement("orvane-passwords");
    const rect = field.getBoundingClientRect();
    // Styles go through the CSSOM and a constructed stylesheet: a page's
    // Content-Security-Policy (NetSuite's, for one) blocks inline styles.
    for (const [name, value] of [
      ["all", "initial"],
      ["position", "fixed"],
      ["left", `${Math.round(rect.left)}px`],
      ["top", `${Math.round(rect.bottom + 4)}px`],
      ["z-index", "2147483647"],
      ["display", "block"],
      ["opacity", "1"],
      ["visibility", "visible"],
      ["pointer-events", "auto"],
    ])
      host.style.setProperty(name, value, "important");
    const root = host.attachShadow({ mode: "closed" });
    const style = new CSSStyleSheet();
    style.replaceSync(`
      .list { min-width: ${Math.max(220, Math.round(rect.width))}px; max-width: 360px;
        padding: 4px; border: 1px solid #d5dee3; border-radius: 7px; background: #fff;
        box-shadow: 0 6px 20px rgba(32, 52, 64, .16); font: 13px system-ui, sans-serif;
        color: #2f4250; }
      .head { padding: 5px 8px 4px; font-size: 11px; color: #6d808c; }
      .warn { color: #9a4b45; }
      button { all: unset; box-sizing: border-box; display: flex; flex-direction: column;
        width: 100%; padding: 7px 8px; border-radius: 5px; cursor: pointer; }
      button:hover, button:focus-visible { background: #eef3f5; }
      .user { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dots { font-size: 11px; color: #8597a2; letter-spacing: 1px; }`);
    root.adoptedStyleSheets = [style];
    const list = document.createElement("div");
    list.className = "list";
    const head = document.createElement("div");
    head.className = secure ? "head" : "head warn";
    head.textContent = secure
      ? "Saved logins"
      : "Saved logins · this connection is not secure";
    list.append(head);
    for (const login of logins) {
      const button = document.createElement("button");
      const user = document.createElement("span");
      user.className = "user";
      user.textContent = login.username || "(no username)";
      const dots = document.createElement("span");
      dots.className = "dots";
      // Saved on another host of this site (e.g. app.example.com).
      dots.textContent = login.site ? `•••••••• · ${login.site}` : "••••••••";
      button.append(user, dots);
      // Keep focus in the field; act only on a real click that also started
      // here (not a release landing on a list that just opened under it).
      let pressed = false;
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        pressed = event.isTrusted;
      });
      button.addEventListener("click", (event) => {
        if (event.isTrusted && pressed) void fill(login.id);
        pressed = false;
      });
      list.append(button);
    }
    root.append(list);
    document.documentElement.append(host);
    menu = { host, field };
  }
  /** The user clicked or tabbed into a login field. */
  async function offer(field) {
    if (!logins) await query(!!loginFields()?.password);
    if (!logins?.length || !field.isConnected) return;
    const fields = loginFields();
    const empty = !fields?.password?.value && !fields?.username?.value;
    // One login saved for this exact page on a secure page fills straight
    // away, like Brave; logins from other hosts of the site need a pick.
    if (logins.length === 1 && !logins[0].site && secure && empty && filled !== field)
      void fill(logins[0].id);
    else show(field);
  }
  const isLoginField = (el) => {
    const fields = loginFields();
    return !!el && (el === fields?.password || el === fields?.username);
  };
  // Offer when a real click focuses a login field. Many sites draw a
  // floating <label> (or icon) over the input, so the click itself can land
  // elsewhere: the focus that follows it is what counts.
  let clickedAt = 0;
  addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isTrusted || (menu && event.target === menu.host)) return;
      clickedAt = Date.now();
      const target = event.target instanceof Element ? event.target : undefined;
      const field = target?.closest("label")?.control ?? target;
      // Already focused: no focus event will follow.
      if (isLoginField(field) && field === document.activeElement) void offer(field);
      else hide();
    },
    true,
  );
  addEventListener(
    "focusin",
    (event) => {
      if (Date.now() - clickedAt < 1000 && isLoginField(event.target)) void offer(event.target);
    },
    true,
  );
  addEventListener(
    "keyup",
    (event) => {
      if (!event.isTrusted) return;
      if (event.key === "Escape") hide();
      else if (event.key === "Tab" && isLoginField(document.activeElement))
        void offer(document.activeElement);
    },
    true,
  );
  addEventListener("scroll", () => hide(), { capture: true, passive: true });
  addEventListener("resize", () => hide());
  addEventListener("pagehide", () => hide());

  // ---- Submitted logins ----
  /** The password field of the last submit, to notice when it goes away
   * (a "show password" toggle changes its type but keeps it). */
  let submitted;
  function capture(scope) {
    const passwords = passwordFields(scope || document).filter((el) => el.value);
    if (!passwords.length) {
      const fields = loginFields();
      if (fields?.username?.value && !fields.password)
        ipcRenderer.send("orvane:pw-username", fields.username.value);
      return;
    }
    // Sign-up and change-password forms: the new password is what to save.
    const password = passwords.find(isNew) ?? passwords[passwords.length - 1];
    const old = passwords.find((el) => !isNew(el)) ?? passwords[0];
    ipcRenderer.send("orvane:pw-submitted", {
      username: usernameFor(old)?.value ?? "",
      password: password.value,
    });
    submitted = old;
  }
  addEventListener("submit", (event) => capture(event.target), true);
  addEventListener(
    "click",
    (event) => {
      const button =
        event.isTrusted &&
        event.target instanceof Element &&
        event.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
      if (button) capture(button.closest("form"));
    },
    true,
  );
  addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && event.key === "Enter" && event.target instanceof HTMLInputElement)
        capture(event.target.form);
    },
    true,
  );

  // ---- Watch the page for login forms appearing and disappearing ----
  let timer;
  function scan() {
    timer = undefined;
    if (menu && !visible(menu.field)) hide();
    const fields = loginFields();
    if (fields && !logins) void query(!!fields.password);
    // Forms often disable their fields while signing in; only gone counts.
    if (submitted && !shown(submitted)) {
      submitted = undefined;
      ipcRenderer.send("orvane:pw-form-gone");
    }
  }
  const schedule = () => (timer ??= setTimeout(scan, 300));
  addEventListener("DOMContentLoaded", () => {
    scan();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["type", "style", "class", "hidden"],
    });
  });
}
