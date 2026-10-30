import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("NetSuite bridge restricts callers and guests and parameterizes folder access", async () => {
  const handlers = {};
  const partition = {};
  const sender = {
    getURL: () => "http://localhost:5173/",
    isDestroyed: () => false,
  };
  let executed = "";
  const guest = {
    id: 8,
    session: partition,
    hostWebContents: sender,
    getType: () => "webview",
    isDestroyed: () => false,
    getURL: () => "https://123.app.netsuite.com/app/center/card.nl",
    getTitle: () => "NS",
    executeJavaScript: async (code) => {
      executed = code;
      return vm.runInNewContext(code, {
        location: {
          origin: "https://123.app.netsuite.com",
          hostname: "123.app.netsuite.com",
        },
        window: {
          require: (_names, success) =>
            success({
              query: {
                runSuiteQL: {
                  promise: async ({ query, params }) => ({
                    asMappedResults: () => [{ query, params }],
                  }),
                },
              },
            }),
        },
        setTimeout,
        clearTimeout,
        URL,
      });
    },
  };
  globalThis.__netsuiteTest = {
    ipcMain: {
      handle: (name, fn) => {
        handlers[name] = fn;
      },
    },
    webContents: { getAllWebContents: () => [guest] },
  };
  const source = (
    await readFile(new URL("../electron/netsuite.mjs", import.meta.url), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__netsuiteTest;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  const processing = {
    environments: async (host) =>
      host === sender &&
      guest.getURL().startsWith("https://123.app.netsuite.com/")
        ? [{ id: "https://123.app.netsuite.com" }]
        : [],
    acquire: (host, origin) => {
      if (
        host !== sender ||
        origin !== "https://123.app.netsuite.com" ||
        !guest.getURL().startsWith(origin)
      )
        throw Error("Processing tab is no longer available.");
      return { contents: guest, release: () => {} };
    },
  };
  module.setupNetSuite(
    (url) => url === "http://localhost:5173/",
    partition,
    processing,
  );
  const event = { sender };
  assert.equal((await handlers["orvane:netsuite-tabs"](event)).length, 1);
  const result = await handlers["orvane:netsuite-run"](
    event,
    "https://123.app.netsuite.com",
    "folder",
    { id: -15 },
  );
  assert.deepEqual(Array.from(result.files[0].params), [-15]);
  assert.match(executed, /WHERE folder = \?/);
  const search = await handlers["orvane:netsuite-run"](
    event,
    "https://123.app.netsuite.com",
    "search-files",
    { search: "123" },
  );
  assert.deepEqual(Array.from(search.files[0].params), ["%123%", 123]);
  await assert.rejects(
    handlers["orvane:netsuite-run"](
      event,
      "https://123.app.netsuite.com",
      "folder",
      { id: "1 OR 1=1" },
    ),
    /valid internal ID/,
  );
  await assert.rejects(
    handlers["orvane:netsuite-run"](
      event,
      "https://123.app.netsuite.com",
      "query",
      { sql: "DELETE FROM customer" },
    ),
    /SELECT/,
  );
  await assert.rejects(
    handlers["orvane:netsuite-run"](
      { sender: { ...sender, getURL: () => "https://evil.example" } },
      "https://123.app.netsuite.com",
      "scripts",
    ),
    /Unauthorized/,
  );
  guest.getURL = () => "https://evil.example/";
  await assert.rejects(
    handlers["orvane:netsuite-run"](
      event,
      "https://123.app.netsuite.com",
      "scripts",
    ),
    /no longer available/,
  );
  delete globalThis.__netsuiteTest;
});

test("saving a file rejects concurrent changes and confirms the result", async () => {
  const handlers = {},
    origin = "https://123.app.netsuite.com";
  const sender = {
    getURL: () => "http://localhost:5173/",
    isDestroyed: () => false,
  };
  let content = "original",
    posts = 0;
  const N = {
    runtime: { getCurrentUser: () => ({ id: 1, role: 3 }) },
    query: {
      runSuiteQL: {
        promise: async () => ({
          asMappedResults: () => [
            {
              id: 5,
              name: "test.js",
              url: "/file.js",
              folder: 10,
              filetype: "JAVASCRIPT",
            },
          ],
        }),
      },
    },
  };
  const fetch = async (url, options = {}) => {
    if (
      String(url).includes("edittextmediaitem") &&
      options.method === "POST"
    ) {
      posts++;
      content = options.body.get("mCharData");
      return { ok: true };
    }
    if (String(url).includes("edittextmediaitem"))
      return { ok: true, text: async () => "<form></form>" };
    return { ok: true, text: async () => content };
  };
  class DOMParser {
    parseFromString() {
      return { querySelector: () => ({ value: "token" }) };
    }
  }
  const guest = {
    executeJavaScript: (code) =>
      vm.runInNewContext(code, {
        location: { origin, hostname: "123.app.netsuite.com" },
        window: { require: (_names, ok) => ok(N) },
        fetch,
        DOMParser,
        URL,
        URLSearchParams,
        setTimeout,
        clearTimeout,
      }),
  };
  globalThis.__netsuiteTestSave = {
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    webContents: {},
  };
  const source = (
    await readFile(new URL("../electron/netsuite.mjs", import.meta.url), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__netsuiteTestSave;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  module.setupNetSuite(
    () => true,
    {},
    { acquire: async () => ({ contents: guest, release: () => {} }) },
  );
  const invoke = (args) =>
    handlers["orvane:netsuite-run"]({ sender }, origin, "save-file", args);
  await assert.rejects(
    invoke({ id: 5, original: "outdated", content: "new" }),
    /changed in NetSuite/,
  );
  assert.equal(posts, 0);
  const result = await invoke({ id: 5, original: "original", content: "new" });
  assert.equal(posts, 1);
  assert.equal(content, "new");
  assert.equal(result.content, "new");
  delete globalThis.__netsuiteTestSave;
});

test("folder creation and uploads validate input and confirm the upload", async () => {
  const handlers = {},
    origin = "https://123.app.netsuite.com";
  const sender = {
    getURL: () => "http://localhost:5173/",
    isDestroyed: () => false,
  };
  let uploaded = false,
    values = {};
  const N = {
    record: {
      create: () => ({
        setValue: ({ fieldId, value }) => {
          values[fieldId] = value;
        },
        save: () => 51,
      }),
    },
    query: {
      runSuiteQL: {
        promise: async () => ({
          asMappedResults: () =>
            uploaded ? [{ id: 52, name: "hello.txt" }] : [],
        }),
      },
    },
  };
  const fetch = async (url, options = {}) => {
    if (String(url).includes("importmediabatch")) {
      assert.equal(options.body.get("folder"), "10");
      assert.equal(options.body.get("mediafile").name, "hello.txt");
      uploaded = true;
      return { ok: true };
    }
    return { ok: true, text: async () => "<form></form>" };
  };
  class DOMParser {
    parseFromString() {
      return { querySelector: () => ({ value: "token" }) };
    }
  }
  const guest = {
    executeJavaScript: (code) =>
      vm.runInNewContext(code, {
        location: { origin, hostname: "123.app.netsuite.com" },
        window: { require: (_names, ok) => ok(N) },
        document: { querySelector: () => null },
        fetch,
        DOMParser,
        URL,
        FormData,
        Blob,
        Uint8Array,
        atob,
        setTimeout,
        clearTimeout,
      }),
  };
  globalThis.__netsuiteTestCreate = {
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    webContents: {},
  };
  const source = (
    await readFile(new URL("../electron/netsuite.mjs", import.meta.url), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__netsuiteTestCreate;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  module.setupNetSuite(
    () => true,
    {},
    { acquire: async () => ({ contents: guest, release: () => {} }) },
  );
  const invoke = (op, args) =>
    handlers["orvane:netsuite-run"]({ sender }, origin, op, args);
  await assert.rejects(
    invoke("create-folder", { folderId: 10, name: "../bad" }),
    /valid name/,
  );
  assert.equal(
    (await invoke("create-folder", { folderId: 10, name: "Examples" })).id,
    51,
  );
  assert.equal(values.parent, 10);
  assert.equal(values.name, "Examples");
  assert.equal(
    (
      await invoke("upload-file", {
        folderId: 10,
        name: "hello.txt",
        base64: "aGVsbG8=",
      })
    ).id,
    52,
  );
  await assert.rejects(
    invoke("upload-file", {
      folderId: 10,
      name: "hello.txt",
      base64: "aGVsbG8=",
    }),
    /already exists/,
  );
  delete globalThis.__netsuiteTestCreate;
});

test("script log requests target the chosen script", async () => {
  const handlers = {},
    origin = "https://123.app.netsuite.com";
  const sender = {
    getURL: () => "http://localhost:5173/",
    isDestroyed: () => false,
  };
  let requested;
  const search = {
    createColumn: ({ name }) => ({ name }),
    create: (options) => {
      requested = options;
      return {
        runPaged: {
          promise: async () => ({
            count: 1,
            pageRanges: [{ index: 0 }],
            fetch: {
              promise: async () => ({
                data: [
                  {
                    getValue: ({ name }) =>
                      name === "title" ? "Example" : name,
                  },
                ],
              }),
            },
          }),
        },
      };
    },
  };
  const guest = {
    executeJavaScript: (code) =>
      vm.runInNewContext(code, {
        location: { origin, hostname: "123.app.netsuite.com" },
        window: { require: (_names, ok) => ok({ search }) },
        setTimeout,
        clearTimeout,
      }),
  };
  globalThis.__netsuiteTestLogs = {
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    webContents: {},
  };
  const source = (
    await readFile(new URL("../electron/netsuite.mjs", import.meta.url), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__netsuiteTestLogs;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  module.setupNetSuite(
    () => true,
    {},
    { acquire: async () => ({ contents: guest, release: () => {} }) },
  );
  const result = await handlers["orvane:netsuite-run"](
    { sender },
    origin,
    "script-logs",
    { id: 42 },
  );
  assert.equal(requested.type, "scriptexecutionlog");
  assert.equal(requested.filters[0][2], 42);
  assert.equal(result.rows[0].title, "Example");
  delete globalThis.__netsuiteTestLogs;
});

test("rename, move and delete validate input and confirm the result in NetSuite", async () => {
  const handlers = {},
    origin = "https://123.app.netsuite.com",
    sender = { getURL: () => "http://localhost:5173/", isDestroyed: () => false },
    posts = [],
    state = { fileName: "old.js", fileFolder: 10, folderGone: false, fileGone: false };
  const N = {
    runtime: { getCurrentUser: () => ({ id: 5, role: 3 }) },
    record: {
      submitFields: () => {},
      delete: ({ type, id }) => {
        assert.equal(type, "folder");
        assert.equal(id, 30);
        state.folderGone = true;
      },
    },
    query: {
      runSuiteQL: {
        promise: async ({ query, params }) => ({
          asMappedResults: () => {
            if (/SELECT id, name, folder, filesize, filetype FROM file WHERE id/.test(query))
              return [{ id: 11, name: state.fileName, folder: state.fileFolder, filesize: 4, filetype: "JAVASCRIPT" }];
            if (/SELECT name FROM file WHERE id/.test(query)) return [{ name: state.fileName }];
            if (/FROM file WHERE folder = \? AND id IN/.test(query))
              return params[0] === state.fileFolder ? [{ id: 11 }] : [];
            if (/FROM file WHERE id IN/.test(query)) return state.fileGone ? [] : [{ id: 11 }];
            if (/FROM MediaItemFolder WHERE id IN/.test(query)) return state.folderGone ? [] : [{ id: 30 }];
            return [];
          },
        }),
      },
    },
  };
  const fetch = async (url, options = {}) => {
    url = String(url);
    if (options.method === "POST") {
      posts.push({ url, body: options.body });
      if (url.includes("_grpMove=T")) {
        assert.match(url, /newfolder=20/);
        assert.match(String(options.body), /sa11fldF=T/);
        state.fileFolder = 20;
      } else if (options.body.get?.("delete_media") === "Delete") {
        assert.equal(options.body.get("id"), "11");
        state.fileGone = true;
      } else if (url.endsWith("/app/common/media/mediaitem.nl")) {
        assert.equal(options.body.get("id"), "11");
        state.fileName = options.body.get("name");
      }
      return { ok: true };
    }
    return { ok: true, text: async () => "<form></form>" };
  };
  class DOMParser {
    parseFromString() {
      return { querySelector: () => ({ value: "token" }) };
    }
  }
  const guest = {
    executeJavaScript: (code) =>
      vm.runInNewContext(code, {
        location: { origin, hostname: "123.app.netsuite.com" },
        window: { require: (_names, ok) => ok(N) },
        document: { querySelector: () => null },
        fetch,
        DOMParser,
        URL,
        URLSearchParams,
        FormData,
        Blob,
        Date,
        setTimeout,
        clearTimeout,
      }),
  };
  globalThis.__netsuiteTestItems = {
    ipcMain: { handle: (name, fn) => (handlers[name] = fn) },
    webContents: {},
  };
  const source = (
    await readFile(new URL("../electron/netsuite.mjs", import.meta.url), "utf8")
  ).replace(
    'import { ipcMain, webContents } from "electron";',
    "const { ipcMain, webContents } = globalThis.__netsuiteTestItems;",
  );
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(source).toString("base64")
  );
  module.setupNetSuite(
    () => true,
    {},
    { acquire: async () => ({ contents: guest, release: () => {} }) },
  );
  const invoke = (op, args) =>
    handlers["orvane:netsuite-run"]({ sender }, origin, op, args);
  await assert.rejects(
    invoke("rename-item", { kind: "file", id: -5, folderId: 10, name: "x.js" }),
    /valid name/,
  );
  await assert.rejects(
    invoke("rename-item", { kind: "file", id: 11, folderId: 10, name: "a/b.js" }),
    /valid name/,
  );
  assert.deepEqual(
    { ...(await invoke("rename-item", { kind: "file", id: 11, folderId: 10, name: "new.js" })) },
    { id: 11, name: "new.js" },
  );
  await assert.rejects(
    invoke("move-items", { folderId: 10, targetId: 10, fileIds: [11], folderIds: [] }),
    /different destination/,
  );
  await assert.rejects(
    invoke("move-items", { folderId: 10, targetId: 30, fileIds: [], folderIds: [30] }),
    /different destination/,
  );
  assert.deepEqual(
    { ...(await invoke("move-items", { folderId: 10, targetId: 20, fileIds: [11], folderIds: [] })) },
    { moved: 1 },
  );
  await assert.rejects(
    invoke("delete-items", { folderId: 20, fileIds: [-15], folderIds: [] }),
    /Choose files or folders/,
  );
  const deleted = await invoke("delete-items", { folderId: 20, fileIds: [11], folderIds: [30] });
  assert.equal(deleted.deleted, 2);
  assert.equal(deleted.remaining.length, 0);
  assert.equal(posts.length, 3);
  delete globalThis.__netsuiteTestItems;
});
