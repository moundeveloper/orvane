import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("epoch changes reject both an active result and a queued read without replay or a leaked reservation", async () => {
  const host = {
    id: 11,
    getURL: () => "http://localhost:5173/",
    isDestroyed: () => false,
  };
  let epoch = 1,
    acquired = 0,
    released = 0,
    executed = 0;
  let entered: () => void = () => {},
    finish: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  (globalThis as any).__queuedEpochTest = {
    ipcMain: { handle: () => {} },
    webContents: {},
  };
  const source = (
    await readFile(resolve("electron/netsuite.mjs"), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__queuedEpochTest;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  const service = module.setupNetSuite(
    (url: string) => url === host.getURL(),
    {},
    {
      reload: async () => false,
      acquire: async () => {
        acquired++;
        return {
          contents: {
            executeJavaScript: async () => {
              executed++;
              entered();
              await blocked;
              return '{"result":{"rows":[]}}';
            },
          },
          release: () => {
            released++;
          },
        };
      },
    },
    { sessionEpoch: () => epoch },
  );
  try {
    const first = service.run(
      host,
      "https://123.app.netsuite.com",
      "query",
      { sql: "SELECT id FROM employee" },
      1,
    );
    await started;
    const second = service.run(
      host,
      "https://123.app.netsuite.com",
      "query",
      { sql: "SELECT id FROM employee" },
      1,
    );
    const assertions = Promise.all([
      assert.rejects(first, { code: "SESSION_CHANGED" }),
      assert.rejects(second, { code: "SESSION_CHANGED" }),
    ]);
    epoch = 2;
    finish();
    await assertions;
    assert.equal(acquired, 1);
    assert.equal(executed, 1);
    assert.equal(released, 1);
  } finally {
    finish();
    delete (globalThis as any).__queuedEpochTest;
  }
});
