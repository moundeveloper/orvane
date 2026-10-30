import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

test('processing pages group by origin, stay busy during calls and close cleanly', async () => {
  const handlers = {}, partition = {}, owner = new EventEmitter(), timers = [], windows = [];
  Object.assign(owner, { id: 4, getURL: () => 'http://localhost:5173/', isDestroyed: () => false, send: () => {} });
  const sources = ['https://123-sb1.app.netsuite.com/a', 'https://123-sb1.app.netsuite.com/b', 'https://123-sb2.app.netsuite.com/a'].map((url, i) => ({ id: i + 1, session: partition, hostWebContents: owner, getType: () => 'webview', isDestroyed: () => false, getURL: () => url }));
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.dead = false; this.webContents = new EventEmitter(); Object.assign(this.webContents, { getURL: () => this.url || '', isDestroyed: () => this.dead, setWindowOpenHandler: () => {} }); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    async loadURL(url) { this.loads = (this.loads || 0) + 1; this.url = url; this.webContents.emit('did-start-loading'); this.webContents.emit('did-finish-load'); }
    static fromWebContents() { return {}; }
  }
  globalThis.__processingTest = { BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers[name] = fn }, webContents: { getAllWebContents: () => sources }, setInterval: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; } };
  const source = (await readFile(new URL('../electron/processing.mjs', import.meta.url), 'utf8')).replace('import { BrowserWindow, ipcMain, webContents } from "electron";', 'const { BrowserWindow, ipcMain, webContents, setInterval } = globalThis.__processingTest;');
  const { setupProcessing } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const manager = setupProcessing({ partition, isOrvane: url => url === 'http://localhost:5173/' });
  const env = await manager.environments(owner);
  assert.equal(env.length, 2); assert.equal(env.find(e => e.id.includes('sb1')).count, 2); assert.equal(env[0].status, 'ready');
  const id = env[0].id, acquired = await manager.acquire(owner, id);
  assert.equal(timers[0].ms, 8 * 60 * 1000);
  assert.throws(() => handlers['orvane:processing-close']({ sender: owner }, id), /busy/);
  timers[0].fn(); assert.equal(windows[0].loads, 1);
  acquired.release(); timers[0].fn(); assert.equal(windows[0].loads, 2); handlers['orvane:processing-close']({ sender: owner }, id);
  assert.equal((await manager.environments(owner)).find(e => e.id === id).status, 'stopped');
  await handlers['orvane:processing-create']({ sender: owner }, 1);
  assert.equal((await manager.environments(owner)).find(e => e.id === id).status, 'ready');
  for (const entry of handlers['orvane:processing-list']({ sender: owner })) handlers['orvane:processing-close']({ sender: owner }, entry.id);
  delete globalThis.__processingTest;
});

test('requests wait for startup and recover a failed or closed NetSuite page', async () => {
  const handlers = {}, partition = {}, owner = new EventEmitter(), windows = [];
  Object.assign(owner, { id: 31, getURL: () => 'http://localhost:5173/', isDestroyed: () => false, send: () => {} });
  const origin = 'https://456-sb1.app.netsuite.com';
  const sourceTab = { id: 5, session: partition, hostWebContents: owner, getType: () => 'webview', isDestroyed: () => false, getURL: () => origin + '/app/home' };
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.dead = false; this.webContents = new EventEmitter(); Object.assign(this.webContents, { getURL: () => this.url || '', isDestroyed: () => this.dead, setWindowOpenHandler: () => {} }); }
    isDestroyed() { return this.dead; }
    destroy() { this.dead = true; this.emit('closed'); }
    loadURL(url) { this.webContents.emit('did-start-loading'); return new Promise((resolve, reject) => { this.finish = success => { if (success) { this.url = url; this.webContents.emit('did-finish-load'); resolve(); } else { this.webContents.emit('did-fail-load', {}, -2, 'failed', url, true); reject(Error('failed')); } }; }); }
    static fromWebContents() { return {}; }
  }
  globalThis.__processingTest2 = { BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers[name] = fn }, webContents: { getAllWebContents: () => [sourceTab] } };
  const code = (await readFile(new URL('../electron/processing.mjs', import.meta.url), 'utf8')).replace('import { BrowserWindow, ipcMain, webContents } from "electron";', 'const { BrowserWindow, ipcMain, webContents } = globalThis.__processingTest2;');
  const { setupProcessing } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const manager = setupProcessing({ partition, isOrvane: () => true });
  await manager.environments(owner);
  let settled = false;
  const first = manager.acquire(owner, origin).then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  windows[0].finish(true);
  const acquired = await first; assert.equal(settled, true); acquired.release();
  handlers['orvane:processing-close']({ sender: owner }, origin);
  const restarted = manager.acquire(owner, origin);
  await Promise.resolve(); assert.equal(windows.length, 2);
  windows[1].finish(false);
  await new Promise(resolve => setImmediate(resolve));
  windows[1].finish(true);
  const recovered = await restarted; recovered.release();
  windows[1].webContents.emit('did-fail-load', {}, -2, 'failed', origin, true);
  manager.sourceChanged(sourceTab);
  assert.equal((await manager.environments(owner))[0].status, 'loading');
  windows[1].finish(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await manager.environments(owner))[0].status, 'ready');
  handlers['orvane:processing-close']({ sender: owner }, origin);
  delete globalThis.__processingTest2;
});
