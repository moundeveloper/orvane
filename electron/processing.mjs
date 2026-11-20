import { BrowserWindow, WebContentsView, ipcMain, webContents } from "electron";
import { isNetSuitePage, netSuiteLogin } from "./netsuite-login.mjs";

// A page with no native window. Processing pages used to be hidden
// BrowserWindows owned by the workspace; after a tray reopen Windows could
// still draw one as a dark "NetSuite Login" box while it reported itself
// hidden. A WebContentsView never attached to a window has nothing to draw.
// Same shape as the BrowserWindow it replaces, for the code below.
// The view itself must stay referenced: once it is garbage-collected Electron
// destroys its webContents, and a NetSuite call running in it never settles.
export function headlessPage(webPreferences) {
  const view = new WebContentsView({ webPreferences });
  const contents = view.webContents;
  return {
    view,
    webContents: contents,
    isDestroyed: () => contents.isDestroyed(),
    destroy: () => { if (!contents.isDestroyed()) contents.close(); },
    loadURL: url => contents.loadURL(url),
    on: (name, listener) => contents.on(name === 'closed' ? 'destroyed' : name, listener),
  };
}

// Headless, session-sharing browser pages owned by the Orvane window. Processing
// pages never expose Node or a preload, and are not addressable by websites.
export function setupProcessing({ partition, isOrvane }) {
  const entries = new Map(), stopped = new Set();
  const temporaryPages = new Set();
  const trusted = e => !e.sender.isDestroyed() && isOrvane(e.sender.getURL());
  const assertOwner = e => { if (!trusted(e)) throw Error("Unauthorized request."); };
  const site = url => { try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) ? u : null; } catch { return null; } };
  const netSuite = url => { const u = site(url); return !!u && isNetSuitePage(url) && u.hostname !== 'system.netsuite.com'; };
  const listSources = host => webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === host && w.session === partition && site(w.getURL()));
  const key = (host, origin) => `${host.id}:${origin}`;
  const describe = entry => ({ id: entry.id, origin: entry.origin, label: entry.label, status: entry.status, url: entry.window.webContents.isDestroyed() ? '' : entry.window.webContents.getURL(), autoRefresh: entry.autoRefresh, busy: entry.busy > 0, temporary: entry.temporary });
  const update = entry => { if (!entry.owner.isDestroyed()) entry.owner.send('orvane:processing-changed'); };
  const onLogin = url => !!netSuiteLogin(url) ||
    (!isNetSuitePage(url) && /\/app\/login\//i.test(site(url)?.pathname || ''));
  /** Set by passwords.mjs: lets a page Orvane (re)loads sign in again even
   * after an earlier try in it was stopped. */
  let resetSignIn = () => {};
  /** Signed out and not signing back in: try again a few times. */
  const RETRY_AFTER = 30000, RETRIES = 3;
  function retryLater(entry) {
    if (entry.temporary || entry.retryTimer || entry.retries >= RETRIES || entry.window.isDestroyed()) return;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (entry.window.isDestroyed() || entry.status === 'ready' || entry.busy) return;
      entry.retries++;
      void load(entry).catch(() => {});
    }, RETRY_AFTER);
    entry.retryTimer.unref?.();
  }
  // On a NetSuite login page, give auto sign-in (passwords.mjs) a moment to
  // finish before reporting the result.
  const signingIn = entry => new Promise(done => {
    const contents = entry.window.webContents;
    if (contents.isDestroyed() || !onLogin(contents.getURL())) return done();
    const finish = () => { clearTimeout(timer); contents.removeListener('did-finish-load', check); done(); };
    const check = () => { if (!onLogin(contents.getURL())) finish(); };
    const timer = setTimeout(finish, 12000);
    contents.on('did-finish-load', check);
  });
  function load(entry) {
    if (entry.loading) return entry.loading;
    entry.status = 'loading'; update(entry);
    resetSignIn(entry.window.webContents);
    const contents = entry.window.webContents;
    const pending = entry.window.loadURL(entry.target).then(() => signingIn(entry)).then(async () => {
      // Signing in on system.netsuite.com can land on the user's default
      // account: go back to this environment's own page.
      const url = site(contents.getURL());
      if (!contents.isDestroyed() && url && url.origin !== entry.origin && isNetSuitePage(url.href) && !onLogin(url.href)) {
        await entry.window.loadURL(entry.target);
        await signingIn(entry);
      }
    }).then(() => { if (entry.status !== 'ready') retryLater(entry); }).catch(error => {
      if (entry.status !== 'sign-in required') entry.status = 'unavailable';
      update(entry);
      retryLater(entry);
      throw error;
    }).finally(() => { if (entry.loading === pending) entry.loading = undefined; });
    entry.loading = pending;
    return pending;
  }
  function dispose(entry) {
    clearInterval(entry.timer);
    clearTimeout(entry.retryTimer);
    entry.owner.removeListener('destroyed', entry.closeWithOwner);
    if (entry.temporary) temporaryPages.delete(entry);
    else if (entries.get(key(entry.owner, entry.origin)) === entry) entries.delete(key(entry.owner, entry.origin));
    update(entry);
  }
  function create(owner, url, temporary = false) {
    const u = site(url);
    if (!u) throw Error('Open a web page before creating a processing tab.');
    const k = key(owner, u.origin), existing = entries.get(k);
    if (!temporary) {
      stopped.delete(k);
      if (existing && !existing.window.isDestroyed()) return existing;
    }
    const ns = netSuite(u.href);
    const target = ns ? `${u.origin}/app/center/card.nl` : u.href;
    if (!BrowserWindow.fromWebContents(owner)) throw Error('Browser window is unavailable.');
    const window = headlessPage({ partition: 'persist:orvane-browser', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false });
    const entry = { id: temporary ? `temporary:${window.webContents.id}` : u.origin, origin: u.origin, label: u.hostname, owner, window, target, status: 'loading', autoRefresh: ns && !temporary, busy: 0, timer: undefined, loading: undefined, retries: 0, retryTimer: undefined, temporary,
      closeWithOwner: () => { if (!window.isDestroyed()) window.destroy(); } };
    if (temporary) temporaryPages.add(entry);
    else entries.set(k, entry);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Signed out, NetSuite sends the page to a login page on another of its
    // hosts (system.netsuite.com…): follow it so it can sign back in.
    window.webContents.on('will-navigate', (event, url) => { if (site(url)?.origin !== entry.origin && !(ns && isNetSuitePage(url))) event.preventDefault(); });
    window.webContents.on('will-redirect', (event, url) => { if (site(url)?.origin !== entry.origin && !(netSuite(entry.origin) && site(url)?.protocol === 'https:' && /(^|\.)netsuite\.com$/i.test(site(url)?.hostname || ''))) { event.preventDefault(); entry.status = 'sign-in required'; update(entry); } });
    // Main-frame navigations only: iframes and dashboard portlets also start
    // loads, and the status must not go back to "loading" for those.
    window.webContents.on('did-start-navigation', (details, legacyUrl, inPlace, legacyMain) => {
      if (!(details?.isMainFrame ?? legacyMain) || (details?.isSameDocument ?? inPlace)) return;
      // The session ended while the page was in use: a new sign-in.
      if (entry.status === 'ready' && onLogin(details?.url ?? legacyUrl)) resetSignIn(window.webContents);
      entry.status = 'loading'; update(entry);
    });
    window.webContents.on('did-finish-load', () => {
      const url = site(window.webContents.getURL());
      entry.status = url?.origin === entry.origin && !onLogin(url.href) ? 'ready' : 'sign-in required';
      if (entry.status === 'ready') { entry.retries = 0; clearTimeout(entry.retryTimer); entry.retryTimer = undefined; }
      else if (!entry.loading) retryLater(entry);
      update(entry);
    });
    window.webContents.on('did-fail-load', (_e, code, _description, _url, main) => { if (main && code !== -3) { entry.status = 'unavailable'; update(entry); } });
    window.on('closed', () => dispose(entry));
    owner.once('destroyed', entry.closeWithOwner);
    if (entry.autoRefresh) {
      entry.timer = setInterval(() => { if (!entry.busy && entry.status === 'ready' && !window.isDestroyed()) void load(entry).catch(() => {}); }, 8 * 60 * 1000);
      entry.timer.unref?.();
    }
    void load(entry).catch(() => {});
    update(entry);
    return entry;
  }
  function list(host) { return [...entries.values(), ...temporaryPages].filter(e => e.owner === host && !e.window.isDestroyed()).map(describe); }
  async function environments(host) {
    const sources = listSources(host).filter(w => netSuite(w.getURL()));
    const origins = new Map();
    for (const source of sources) {
      const url = new URL(source.getURL());
      const item = origins.get(url.origin) ?? { source: null, count: 0 };
      item.count++;
      if (!item.source && !onLogin(url.href)) item.source = source;
      origins.set(url.origin, item);
    }
    // Existing processing tabs remain available after the last visible tab closes.
    for (const entry of entries.values()) if (entry.owner === host && netSuite(entry.origin) && !origins.has(entry.origin)) origins.set(entry.origin, { source: null, count: 0 });
    const result = [];
    for (const [origin, value] of origins) {
      const k = key(host, origin);
      const entry = entries.get(k) || (stopped.has(k) || !value.source ? null : create(host, value.source.getURL()));
      const status = stopped.has(k) ? 'stopped' : 'sign-in required';
      result.push({ ...(entry ? describe(entry) : { id: origin, origin, label: new URL(origin).hostname, status, autoRefresh: false }), count: value.count });
    }
    return result;
  }
  function sourceChanged(source) {
    const url = site(source.getURL());
    if (!url || !netSuite(url.href) || onLogin(url.href)) return;
    const owner = source.hostWebContents;
    const entry = owner && entries.get(key(owner, url.origin));
    if (entry && !entry.window.isDestroyed() && !entry.busy && !entry.loading && entry.status !== 'ready')
      void load(entry).catch(() => {});
  }
  function openRecord(host, origin, kind, id) {
    if (!netSuite(origin) || !Number.isSafeInteger(id) || id === 0 || !['script', 'deployment', 'file', 'folder'].includes(kind) || (id <= 0 && kind !== 'folder')) throw Error('Invalid NetSuite record.');
    const source = listSources(host).find(w => site(w.getURL())?.origin === origin);
    if (!source) throw Error('Open a Browser tab for this environment first.');
    const path = { script: '/app/common/scripting/script.nl', deployment: '/app/common/scripting/scriptrecord.nl', file: '/app/common/media/mediaitem.nl', folder: '/app/common/media/mediaitemfolder.nl' }[kind];
    host.send('orvane:open-tab', { from: source.id, url: `${origin}${path}?id=${id}`, background: false });
  }
  async function acquire(host, origin, { parallel = false } = {}) {
    if (!netSuite(origin)) throw Error('Choose a valid NetSuite environment.');
    const k = key(host, origin);
    let entry = entries.get(k);
    if (!entry || entry.window.isDestroyed()) {
      const source = listSources(host).find(w => site(w.getURL())?.origin === origin);
      if (!source) throw Error('Open and sign in to this NetSuite account in Browser.');
      entry = create(host, source.getURL());
    }
    const wait = async promise => {
      let timer;
      try { await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Connecting to NetSuite took too long.')), 30000); })]); }
      finally { clearTimeout(timer); }
    };
    if (entry.loading) { try { await wait(entry.loading); } catch { /* Try once after a failed startup. */ } }
    if (entry.window.isDestroyed()) throw Error('The NetSuite connection was closed. Try again.');
    if (entry.loading) throw Error('Connecting to NetSuite took too long.');
    if (entry.status !== 'ready' || site(entry.window.webContents.getURL())?.origin !== origin) {
      if (entry.busy) throw Error('Connecting to NetSuite. Try again shortly.');
      try { await wait(load(entry)); } catch { /* Report the sign-in/connection state below. */ }
    }
    if (entry.window.isDestroyed() || entry.status !== 'ready' || site(entry.window.webContents.getURL())?.origin !== origin)
      throw Error('Could not connect to NetSuite. Make sure you are signed in to this account in Browser.');
    if (parallel && entry.busy) {
      const spare = create(host, origin, true);
      try {
        await wait(spare.loading);
        if (spare.status !== 'ready') throw Error('The temporary NetSuite processing tab could not sign in.');
        entry = spare;
      } catch (error) {
        spare.closeWithOwner();
        throw error;
      }
    }
    entry.busy++;
    update(entry);
    let released = false;
    return { contents: entry.window.webContents, temporary: entry.temporary, release: () => {
      if (released) return;
      released = true;
      entry.busy--;
      if (entry.temporary) entry.closeWithOwner();
      else update(entry);
    } };
  }
  ipcMain.handle('orvane:processing-list', e => { assertOwner(e); return list(e.sender); });
  ipcMain.handle('orvane:processing-create', (e, id) => { assertOwner(e); const source = listSources(e.sender).find(w => w.id === id); if (!source) throw Error('Browser tab is no longer available.'); return describe(create(e.sender, source.getURL())); });
  ipcMain.handle('orvane:processing-refresh', async (e, origin) => { assertOwner(e); const entry = entries.get(key(e.sender, origin)); if (!entry || entry.window.isDestroyed()) throw Error('Processing tab is no longer available.'); if (entry.busy) throw Error('This processing tab is busy.'); entry.retries = 0; await load(entry); return describe(entry); });
  ipcMain.handle('orvane:processing-close', (e, origin) => { assertOwner(e); const entry = entries.get(key(e.sender, origin)); if (!entry) return; if (entry.busy) throw Error('This processing tab is busy.'); stopped.add(key(e.sender, origin)); entry.closeWithOwner(); });
  /** A hidden processing page (they may sign in by themselves too). */
  const owns = contents => [...entries.values(), ...temporaryPages].some(e => !e.window.isDestroyed() && e.window.webContents === contents);
  /** Reload (and so sign in again); true once it is ready. */
  async function reload(host, origin) {
    const entry = entries.get(key(host, origin));
    if (!entry || entry.window.isDestroyed() || entry.busy) return false;
    entry.retries = 0;
    await load(entry);
    return entry.status === 'ready';
  }
  return { environments, acquire, openRecord, sourceChanged, owns, reload,
    supportsParallelReads: true, onSignInReset: fn => { resetSignIn = fn; } };
}
