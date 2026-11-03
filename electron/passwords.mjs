// Saved passwords for the Browser app, like Chromium/Brave's: the vault is
// one file encrypted with the OS key store (DPAPI on Windows, Keychain on
// macOS, libsecret/KWallet on Linux) and lives only in this process.
// Passwords travel only to pages of the origin they were saved for, or, when
// the user picks one, of the same site (another host under the same
// registrable domain over https, like Chromium's public-suffix matches),
// via a sandboxed preload (password-fill.cjs); Orvane's own window sees sites
// and usernames, never a password. On genuine NetSuite login pages of the
// accounts auto sign-in covers (netsuite-login.mjs), a saved login is also
// filled and submitted by itself, once per tab until a sign-in works.
import { clipboard, ipcMain, safeStorage, session, webContents } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDomain } from "tldts";
import {
  autoLoginAccount,
  autoLoginCandidates,
  isNetSuitePage,
  netSuiteAccount,
  netSuiteLogin,
  netSuiteSignedIn,
} from "./netsuite-login.mjs";

const MAX_LOGINS = 5000;
const CANDIDATE_LIFE = 3 * 60000;
const USERNAME_LIFE = 10 * 60000;
const PROMPT_LIFE = 5 * 60000;
const CLIPBOARD_LIFE = 30000;
/** An auto sign-in with no result by then (the user went elsewhere). */
const ATTEMPT_LIFE = 5 * 60000;
/** A processing page signs in at most this often. */
const PROCESSING_GAP = 2 * 60000;
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

const text = (value, max) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const secureOrigin = (origin) => {
  const { protocol, hostname } = new URL(origin);
  return protocol === "https:" || LOCAL.includes(hostname);
};
/** Registrable domain of an https origin ("netsuite.com"), private suffixes
 * included so separate owners (x.github.io, y.github.io) never match. */
const siteKey = (origin) => {
  const { protocol, hostname } = new URL(origin);
  if (protocol !== "https:") return;
  return getDomain(hostname, { allowPrivateDomains: true }) ?? undefined;
};
/** Another host of the same site: offered only on request, never auto-filled. */
const related = (a, b) => a !== b && !!siteKey(a) && siteKey(a) === siteKey(b);

/**
 * @param {{ partition: string, isOrvane: (url: string) => boolean, isProcessing?: (contents: Electron.WebContents) => boolean, folder: string }} options
 * @returns {(contents: Electron.WebContents) => void} call for every page
 *   contents (webviews and their popups) in the Browser session.
 */
export function setupPasswords({ partition, isOrvane, isProcessing = () => false, folder }) {
  const file = join(folder, "passwords.vault");
  const sites = session.fromPartition(partition);
  sites.registerPreloadScript({
    type: "frame",
    id: "orvane-passwords",
    filePath: join(import.meta.dirname, "password-fill.cjs"),
  });

  /** @type {{ logins: { id: string, origin: string, username: string, password: string, created: number, updated: number, used?: number, autoLogin?: boolean }[], never: string[] }} */
  let vault = { logins: [], never: [] };
  /** "ok", "unavailable" (no OS encryption) or "unreadable" (left untouched). */
  let state = "loading";
  let loading;
  const ready = () => (loading ??= load()).then(() => state === "ok");
  async function load() {
    const backend =
      process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : "";
    if (!(await safeStorage.isAsyncEncryptionAvailable()) || backend === "basic_text") {
      state = "unavailable";
      return;
    }
    let data;
    try {
      data = await readFile(file);
    } catch (error) {
      state = error?.code === "ENOENT" ? "ok" : "unreadable";
      return;
    }
    try {
      const { result } = await safeStorage.decryptStringAsync(data);
      const saved = JSON.parse(result);
      vault = {
        logins: Array.isArray(saved.logins) ? saved.logins : [],
        never: Array.isArray(saved.never) ? saved.never : [],
      };
      state = "ok";
    } catch {
      // Another user/machine's key or a damaged file: never overwrite it.
      state = "unreadable";
    }
  }
  let writing = Promise.resolve();
  const persist = async () => {
    const data = await safeStorage.encryptStringAsync(JSON.stringify(vault));
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, data, { mode: 0o600 });
    await rename(temp, file);
  };
  const save = () => (writing = writing.catch(() => undefined).then(persist));

  // ---- Pages (Browser session, top frame only) ----
  /** The page's origin as Chromium reports it, never what the page claims. */
  function siteOf(event) {
    const frame = event.senderFrame;
    if (event.sender.session !== sites || !frame || frame.parent) return;
    const { origin } = frame;
    if (!/^https?:\/\/[^/]+$/.test(origin) || isOrvane(origin)) return;
    return origin;
  }
  // Popups belong to the Browser tab (webview) that opened them.
  const owners = new Map();
  const ownerOf = (id) => owners.get(id) ?? id;
  /** Submitted logins waiting to see whether the sign-in worked. */
  const candidates = new Map();
  /** Usernames from the first step of two-step sign-ins. */
  const usernames = new Map();
  const prompts = new Map();

  function dropCandidate(id) {
    clearTimeout(candidates.get(id)?.timer);
    candidates.delete(id);
  }
  function flush(id) {
    const candidate = candidates.get(id);
    dropCandidate(id);
    // The owner is looked up now: a closing popup forgets it right after.
    if (candidate && Date.now() - candidate.at < CANDIDATE_LIFE)
      void offer(ownerOf(id), candidate).catch(() => undefined);
  }
  async function offer(ownerId, { origin, username, password }) {
    if (!(await ready()) || vault.never.includes(origin)) return;
    const saved = vault.logins.filter((l) => l.origin === origin);
    // A password-only form on a site with one saved login updates that login.
    const existing =
      saved.find((l) => l.username === username) ??
      (!username && saved.length === 1 ? saved[0] : undefined);
    if (existing?.password === password) return;
    if (!existing && vault.logins.length >= MAX_LOGINS) return;
    const owner = webContents.fromId(ownerId);
    const host = owner?.hostWebContents;
    if (!host || host.isDestroyed()) return;
    for (const [key, prompt] of prompts)
      if (prompt.owner === owner.id) forgetPrompt(key);
    const id = randomUUID();
    prompts.set(id, {
      owner: owner.id,
      origin,
      username: existing?.username ?? username,
      password,
      existing: existing?.id,
      timer: setTimeout(() => forgetPrompt(id), PROMPT_LIFE),
    });
    host.send("orvane:password-prompt", {
      from: owner.id,
      id,
      origin,
      username: existing?.username ?? username,
      update: !!existing,
    });
  }
  function forgetPrompt(id) {
    clearTimeout(prompts.get(id)?.timer);
    prompts.delete(id);
  }

  ipcMain.handle("orvane:pw-logins", async (event, hasPassword) => {
    const origin = siteOf(event);
    if (!origin) return { logins: [], secure: false };
    // The login form is back after submitting: the sign-in failed.
    const candidate = candidates.get(event.sender.id);
    if (hasPassword === true && candidate?.navigated) dropCandidate(event.sender.id);
    if (!(await ready())) return { logins: [], secure: false };
    const newest = (a, b) => b.updated - a.updated;
    return {
      secure: secureOrigin(origin),
      logins: [
        ...vault.logins.filter((l) => l.origin === origin).sort(newest),
        ...vault.logins.filter((l) => related(l.origin, origin)).sort(newest),
      ].map(({ id, username, origin: from }) => ({
        id,
        username,
        ...(from === origin ? {} : { site: new URL(from).host }),
      })),
    };
  });
  ipcMain.handle("orvane:pw-fill", async (event, id) => {
    const origin = siteOf(event);
    if (!origin || typeof id !== "string" || !(await ready())) return;
    const login = vault.logins.find(
      (l) => l.id === id && (l.origin === origin || related(l.origin, origin)),
    );
    return login && { username: login.username, password: login.password };
  });
  ipcMain.on("orvane:pw-username", (event, value) => {
    const origin = siteOf(event);
    const username = text(value, 512)?.trim();
    if (origin && username) usernames.set(event.sender.id, { origin, username, at: Date.now() });
  });
  ipcMain.on("orvane:pw-submitted", (event, login) => {
    const origin = siteOf(event);
    const password = text(login?.password, 1024);
    let username = text(login?.username, 512)?.trim() ?? "";
    if (!origin || !password) return;
    const first = usernames.get(event.sender.id);
    if (!username && first?.origin === origin && Date.now() - first.at < USERNAME_LIFE)
      username = first.username;
    dropCandidate(event.sender.id);
    candidates.set(event.sender.id, { origin, username, password, at: Date.now() });
  });
  // A single-page app removed its login form after submitting: signed in.
  ipcMain.on("orvane:pw-form-gone", (event) => {
    if (siteOf(event)) flush(event.sender.id);
  });

  // ---- NetSuite auto sign-in ----
  /** Auto sign-ins waiting for their result, by Browser tab. Another login
   * page in the same tab before a signed-in page means it failed: the tab
   * stops signing in by itself and the login is paused, so a wrong password
   * can never loop (or lock the NetSuite user out). */
  const attempts = new Map();
  /** Logins whose last auto sign-in failed (until they sign in or change). */
  const failing = new Set();
  /** The NetSuite account each tab last headed to: signed out, NetSuite
   * redirects to system.netsuite.com without naming the account. */
  const headedTo = new Map();
  function notice(contents, kind, origin) {
    const host = contents.hostWebContents;
    if (host && !host.isDestroyed())
      host.send("orvane:auto-login", { from: contents.id, kind, origin });
  }
  /** Browser tabs (webviews) and Orvane's own processing pages. */
  const autoLoginTab = (event) =>
    (event.sender.getType() === "webview" && !!event.sender.hostWebContents) ||
    isProcessing(event.sender);
  /** When each processing page last signed in by itself. */
  const processingSignIns = new Map();
  /** A processing page must never sign in over a Browser tab that is signed
   * in to another account (NetSuite may keep one session per user, so it
   * would sign that tab out), nor sign in again right after doing so. */
  function processingMayLogIn(contents, account) {
    if (Date.now() - (processingSignIns.get(contents.id) ?? 0) < PROCESSING_GAP) return false;
    return !webContents
      .getAllWebContents()
      .some(
        (other) =>
          !other.isDestroyed() &&
          other.getType() === "webview" &&
          other.session === sites &&
          netSuiteSignedIn(other.getURL()) &&
          netSuiteAccount(other.getURL()) !== account,
      );
  }

  ipcMain.handle("orvane:pw-auto", async (event) => {
    const origin = siteOf(event);
    const page = origin && autoLoginTab(event) && netSuiteLogin(event.senderFrame.url);
    if (!page || page.origin !== origin) return;
    const login = { ...page, account: page.account ?? headedTo.get(event.sender.id) };
    // system.netsuite.com opened directly names no account: NetSuite signs
    // in to the user's default one, so it is allowed. A known account must
    // be one auto sign-in covers.
    if (login.account ? !autoLoginAccount(login.account) : origin !== "https://system.netsuite.com")
      return;
    if (isProcessing(event.sender) && !processingMayLogIn(event.sender, login.account)) return;
    if (!(await ready())) return;
    const contents = event.sender;
    let pending = attempts.get(contents.id);
    if (pending && !pending.stopped && !pending.challenge && Date.now() - pending.at > ATTEMPT_LIFE) {
      attempts.delete(contents.id);
      pending = undefined;
    }
    if (pending) {
      // The login page came back: hand it to the user instead of retrying.
      if (pending.stopped) return;
      pending.stopped = true;
      if (!pending.challenge) failing.add(pending.login);
      notice(contents, "failed", origin);
      return;
    }
    const candidates = autoLoginCandidates(vault.logins, login);
    const chosen = candidates[0];
    if (!chosen) return;
    if (failing.has(chosen.id)) {
      attempts.set(contents.id, { login: chosen.id, stopped: true });
      notice(contents, "paused", origin);
      return;
    }
    attempts.set(contents.id, { login: chosen.id, at: Date.now() });
    if (isProcessing(contents)) processingSignIns.set(contents.id, Date.now());
    notice(contents, "signing-in", origin);
    return { username: chosen.username, password: chosen.password };
  });
  // A verification code or security question after an auto sign-in: the
  // user answers it; nothing is filled.
  ipcMain.on("orvane:pw-auto-challenge", (event) => {
    const contents = event.sender;
    const pending = attempts.get(contents.id);
    const url = event.senderFrame?.url ?? "";
    if (!pending || pending.challenge || !siteOf(event) || !isNetSuitePage(url)) return;
    pending.challenge = true;
    notice(contents, "challenge", new URL(url).origin);
  });
  function signedIn(contents, url) {
    const pending = attempts.get(contents.id);
    if (!pending || !netSuiteSignedIn(url)) return;
    attempts.delete(contents.id);
    failing.delete(pending.login);
    notice(contents, "done", new URL(url).origin);
    const login = vault.logins.find((l) => l.id === pending.login);
    if (login && state === "ok") {
      login.used = Date.now();
      void save().catch(() => undefined);
    }
  }

  function track(contents) {
    // Includes the first URL of a redirect chain (the account's own host).
    const headed = (event, legacyUrl, _inPlace, legacyMain) => {
      const url = event?.url ?? legacyUrl;
      const main = event?.isMainFrame ?? legacyMain;
      const account = main && typeof url === "string" && netSuiteAccount(url);
      if (account) headedTo.set(contents.id, account);
    };
    contents.on("did-start-navigation", headed);
    contents.on("did-redirect-navigation", headed);
    contents.on("did-create-window", (window) => {
      owners.set(window.webContents.id, ownerOf(contents.id));
    });
    // A new page after submitting: offer to save unless the login form
    // comes back (see orvane:pw-logins).
    contents.on("did-navigate", (_event, url) => {
      signedIn(contents, url);
      const candidate = candidates.get(contents.id);
      if (!candidate) return;
      candidate.navigated = true;
      clearTimeout(candidate.timer);
      candidate.timer = setTimeout(() => flush(contents.id), 2500);
    });
    contents.on("destroyed", () => {
      // Sign-in popups usually close once they are done.
      if (owners.has(contents.id)) flush(contents.id);
      else dropCandidate(contents.id);
      owners.delete(contents.id);
      usernames.delete(contents.id);
      attempts.delete(contents.id);
      headedTo.delete(contents.id);
      processingSignIns.delete(contents.id);
    });
  }

  // ---- Orvane window: manage saved logins and answer save prompts ----
  const fromOrvane = (event) =>
    event.sender.getType() === "window" &&
    event.sender.session === session.defaultSession &&
    !event.senderFrame?.parent &&
    isOrvane(event.senderFrame?.url ?? "");
  const handle = (channel, run) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromOrvane(event)) return;
      await ready();
      return run(...args);
    });

  handle("orvane:passwords-list", () => ({
    state,
    logins:
      state === "ok"
        ? vault.logins
            .map(({ id, origin, username, updated, autoLogin }) => ({
              id,
              origin,
              username,
              updated,
              // Auto sign-in applies to NetSuite logins, on unless turned off.
              ...(isNetSuitePage(origin) ? { autoLogin: autoLogin !== false } : {}),
            }))
            .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
        : [],
    never: state === "ok" ? [...vault.never].sort() : [],
  }));
  handle("orvane:passwords-remove", async (id) => {
    if (state !== "ok") return false;
    const before = vault.logins.length;
    vault.logins = vault.logins.filter((l) => l.id !== id);
    if (vault.logins.length !== before) await save();
    return true;
  });
  handle("orvane:passwords-auto-login", async (id, on) => {
    const login = state === "ok" && typeof on === "boolean" && vault.logins.find((l) => l.id === id);
    if (!login || !isNetSuitePage(login.origin)) return false;
    login.autoLogin = on;
    failing.delete(login.id);
    await save();
    return true;
  });
  handle("orvane:passwords-allow", async (origin) => {
    if (state !== "ok" || !vault.never.includes(origin)) return false;
    vault.never = vault.never.filter((o) => o !== origin);
    await save();
    return true;
  });
  // Copied for 30 seconds, then cleared if it is still on the clipboard.
  // Electron 45 made clipboard calls asynchronous; awaiting works either way.
  handle("orvane:passwords-copy", async (id) => {
    const login = state === "ok" && vault.logins.find((l) => l.id === id);
    if (!login) return false;
    const { password } = login;
    await clipboard.writeText(password);
    setTimeout(async () => {
      if ((await clipboard.readText()) === password) await clipboard.clear();
    }, CLIPBOARD_LIFE);
    return true;
  });
  handle("orvane:password-decide", async (id, choice) => {
    const prompt = prompts.get(id);
    forgetPrompt(id);
    if (!prompt || state !== "ok") return false;
    if (choice === "never") {
      if (!vault.never.includes(prompt.origin)) vault.never.push(prompt.origin);
    } else if (choice === "save") {
      const now = Date.now();
      const existing = vault.logins.find((l) => l.id === prompt.existing);
      if (existing) {
        Object.assign(existing, { password: prompt.password, updated: now });
        failing.delete(existing.id);
      }
      else if (vault.logins.length < MAX_LOGINS)
        vault.logins.push({
          id: randomUUID(),
          origin: prompt.origin,
          username: prompt.username,
          password: prompt.password,
          created: now,
          updated: now,
        });
    } else return true;
    await save();
    return true;
  });

  return track;
}
