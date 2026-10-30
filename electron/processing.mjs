import { BrowserWindow, ipcMain, webContents } from "electron";

// Headless, session-sharing browser pages owned by the Orvane window. Processing
// pages never expose Node or a preload, and are not addressable by websites.
export function setupProcessing({ partition, isOrvane }) {
  const entries = new Map(), stopped = new Set();
  const trusted = e => !e.sender.isDestroyed() && isOrvane(e.sender.getURL());
  const assertOwner = e => { if (!trusted(e)) throw Error("Unauthorized request."); };
  const site = url => { try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) ? u : null; } catch { return null; } };
  const netSuite = url => { const u = site(url); return !!u && u.protocol === 'https:' && /^[a-z0-9-]+\.app\.netsuite\.com$/i.test(u.hostname); };
  const listSources = host => webContents.getAllWebContents().filter(w => !w.isDestroyed() && w.getType() === 'webview' && w.hostWebContents === host && w.session === partition && site(w.getURL()));
  const key = (host, origin) => `${host.id}:${origin}`;
  const describe = entry => ({ id: entry.origin, origin: entry.origin, label: entry.label, status: entry.status, url: entry.window.webContents.isDestroyed() ? '' : entry.window.webContents.getURL(), autoRefresh: entry.autoRefresh });
  const update = entry => { if (!entry.owner.isDestroyed()) entry.owner.send('orvane:processing-changed'); };
  function load(entry) {
    if (entry.loading) return entry.loading;
    entry.status = 'loading'; update(entry);
    const pending = entry.window.loadURL(entry.target).catch(error => {
      if (entry.status !== 'sign-in required') entry.status = 'unavailable';
      update(entry);
      throw error;
    }).finally(() => { if (entry.loading === pending) entry.loading = undefined; });
    entry.loading = pending;
    return pending;
  }
  const dispose = entry => { clearInterval(entry.timer); entries.delete(key(entry.owner, entry.origin)); if (!entry.window.isDestroyed()) entry.window.destroy(); update(entry); };
  async function create(owner, source) {
    const u = site(source.getURL());
    if (!u) throw Error('Open a web page before creating a processing tab.');
    const k = key(owner, u.origin), existing = entries.get(k);
    stopped.delete(k);
    if (existing && !existing.window.isDestroyed()) return existing;
    const ns = netSuite(u.href);
    const target = ns ? `${u.origin}/app/center/card.nl` : u.href;
    const parent = BrowserWindow.fromWebContents(owner);
    if (!parent) throw Error('Browser window is unavailable.');
    const window = new BrowserWindow({ show: false, parent, webPreferences: { partition: 'persist:orvane-browser', sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const entry = { origin: u.origin, label: u.hostname, owner, window, target, status: 'loading', autoRefresh: ns, busy: 0, timer: undefined, loading: undefined };
    entries.set(k, entry);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (site(url)?.origin !== entry.origin) event.preventDefault(); });
    window.webContents.on('will-redirect', (event, url) => { if (site(url)?.origin !== entry.origin && !(netSuite(entry.origin) && site(url)?.protocol === 'https:' && /(^|\.)netsuite\.com$/i.test(site(url)?.hostname || ''))) { event.preventDefault(); entry.status = 'sign-in required'; update(entry); } });
    window.webContents.on('did-start-loading', () => { entry.status = 'loading'; update(entry); });
    window.webContents.on('did-finish-load', () => { const url = site(window.webContents.getURL()); entry.status = url?.origin === entry.origin && !/\/app\/login\//i.test(url.pathname) ? 'ready' : 'sign-in required'; update(entry); });
    window.webContents.on('did-fail-load', (_e, code, _description, _url, main) => { if (main && code !== -3) { entry.status = 'unavailable'; update(entry); } });
    window.on('closed', () => { clearInterval(entry.timer); entries.delete(k); update(entry); });
    owner.once('destroyed', () => { if (!window.isDestroyed()) window.destroy(); });
    entry.timer = setInterval(() => { if (entry.autoRefresh && !entry.busy && entry.status === 'ready' && !window.isDestroyed()) void load(entry).catch(() => {}); }, 8 * 60 * 1000);
    entry.timer.unref?.();
    void load(entry).catch(() => {});
    update(entry);
    return entry;
  }
  function list(host) { return [...entries.values()].filter(e => e.owner === host && !e.window.isDestroyed()).map(describe); }
  async function environments(host) {
    const sources = listSources(host).filter(w => netSuite(w.getURL()));
    const origins = new Map();
    for (const source of sources) { const u = new URL(source.getURL()); const item = origins.get(u.origin) || { source, count: 0 }; item.count++; origins.set(u.origin, item); }
    // Existing processing tabs remain available after the last visible tab closes.
    for (const entry of entries.values()) if (entry.owner === host && netSuite(entry.origin) && !origins.has(entry.origin)) origins.set(entry.origin, { source: null, count: 0 });
    const result = [];
    for (const [origin, value] of origins) {
      const k = key(host, origin);
      const entry = entries.get(k) || (stopped.has(k) ? null : await create(host, value.source));
      result.push(entry ? { ...describe(entry), count: value.count } : { id: origin, origin, label: new URL(origin).hostname, status: 'stopped', autoRefresh: false, count: value.count });
    }
    return result;
  }
  function sourceChanged(source) {
    const url = site(source.getURL());
    if (!url || !netSuite(url.href) || /\/app\/login\//i.test(url.pathname)) return;
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
  async function acquire(host, origin) {
    if (!netSuite(origin)) throw Error('Choose a valid NetSuite environment.');
    const k = key(host, origin);
    let entry = entries.get(k);
    if (!entry || entry.window.isDestroyed()) {
      const source = listSources(host).find(w => site(w.getURL())?.origin === origin);
      if (!source) throw Error('Open and sign in to this NetSuite account in Browser.');
      entry = await create(host, source);
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
    entry.busy++;
    let released = false;
    return { contents: entry.window.webContents, release: () => { if (!released) { released = true; entry.busy--; } } };
  }
  ipcMain.handle('orvane:processing-list', e => { assertOwner(e); return list(e.sender); });
  ipcMain.handle('orvane:processing-create', async (e, id) => { assertOwner(e); const source = listSources(e.sender).find(w => w.id === id); if (!source) throw Error('Browser tab is no longer available.'); return describe(await create(e.sender, source)); });
  ipcMain.handle('orvane:processing-refresh', async (e, origin) => { assertOwner(e); const entry = entries.get(key(e.sender, origin)); if (!entry || entry.window.isDestroyed()) throw Error('Processing tab is no longer available.'); if (entry.busy) throw Error('This processing tab is busy.'); await load(entry); return describe(entry); });
  ipcMain.handle('orvane:processing-close', (e, origin) => { assertOwner(e); const entry = entries.get(key(e.sender, origin)); if (!entry) return; if (entry.busy) throw Error('This processing tab is busy.'); stopped.add(key(e.sender, origin)); dispose(entry); });
  return { environments, acquire, openRecord, sourceChanged };
}
