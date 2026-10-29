import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { LocalDatabase } from "../server/database";
import { emptyWorkspace, makeBlock, uid, type CanvasApp } from "../src/model";
import { readStored } from "./storage-helper";
import { preview } from "vite";
import { localStorageApi } from "../server/storage-api";
import { resolve, join } from "node:path";

function fixture(name = "Shared workspace") {
  const workspace = emptyWorkspace();
  const counter = { ...makeBlock("counter"), label: "Count" };
  const app: CanvasApp = {
    id: uid(),
    name,
    icon: "counter",
    blocks: [counter],
    x: 120,
    y: 120,
    width: 450,
    height: 400,
    archived: false,
    exposed: false,
    group: "",
    accent: "#6f8998",
    padding: 20,
    gap: 12,
    radius: 6,
  };
  workspace.apps = [app];
  return workspace;
}

test("new database examples remain editable after asynchronous initialization", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-ready", "true");
  await page
    .getByRole("textbox", { name: "New task", exact: true })
    .fill("SQLite example");
  await page
    .getByRole("button", { name: "Add to the list", exact: true })
    .click();
  await expect(page.locator(".runtime-list").first()).toContainText(
    "SQLite example",
  );
});

test("invalid earlier browser data remains recoverable and does not initialize an empty SQLite workspace", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "orvane.workspace.v1",
      '{"version":1,"apps":"damaged"}',
    );
  });
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "false");
  await expect(page.locator(".status-area")).toContainText(
    "not a valid Orvane workspace",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("orvane.workspace.v1")),
  ).toBe('{"version":1,"apps":"damaged"}');
  expect(
    await page.evaluate(
      async () => (await (await fetch("/__orvane/storage/state")).json()).data,
    ),
  ).toBeNull();
});

test("verified SQLite persists across connections, enforces leases and stale revision checks", async ({}, info) => {
  const path = info.outputPath("workspace.sqlite"),
    one = new LocalDatabase(path),
    two = new LocalDatabase(path);
  const owner = uid(),
    other = uid(),
    w = fixture();
  try {
    expect(one.sqlite).toBe("3.53.4");
    expect(one.acquire(owner).owned).toBe(true);
    expect(two.acquire(other).owned).toBe(false);
    one.write(owner, 0, w);
    expect(two.read().data).toEqual(w);
    expect(() => two.write(other, 1, emptyWorkspace())).toThrow(
      "Another browser",
    );
    expect(() => one.write(owner, 0, emptyWorkspace())).toThrow(
      "not overwritten",
    );
    expect(two.read().data).toEqual(w);
    one.release(owner);
    expect(two.acquire(other).owned).toBe(true);
    two.write(other, 1, emptyWorkspace(), "Before replacement");
    expect(two.snapshot()?.data).toEqual(w);
  } finally {
    one.close();
    two.close();
  }
  const reopened = new LocalDatabase(path);
  try {
    expect(reopened.revision()).toBe(2);
    expect(reopened.read().data?.apps).toEqual([]);
  } finally {
    reopened.close();
  }
});

test("production preview serves the same disk database without a separate database service", async ({}, info) => {
  const directory = info.outputPath("preview-data");
  const db = new LocalDatabase(join(directory, "workspace.sqlite")),
    owner = uid(),
    data = fixture("Preview disk workspace");
  db.acquire(owner);
  db.write(owner, 0, data);
  db.release(owner);
  db.close();
  const server = await preview({
    configFile: false,
    root: resolve("."),
    plugins: [localStorageApi(directory)],
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    logLevel: "error",
  });
  try {
    const address = server.httpServer.address();
    if (!address || typeof address === "string")
      throw Error("Preview has no local port.");
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${origin}/__orvane/storage/state`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(data);
    expect((await fetch(`${origin}/.orvane/workspace.sqlite`)).status).toBe(
      403,
    );
  } finally {
    await new Promise<void>((resolve) => {
      server.httpServer.close(() => resolve());
      server.httpServer.closeIdleConnections();
    });
  }
});

test("a SQLite failure rolls back both snapshot and workspace atomically", async ({}, info) => {
  const path = info.outputPath("rollback.sqlite"),
    db = new LocalDatabase(path),
    owner = uid(),
    original = fixture();
  const raw = new Database(path);
  try {
    db.acquire(owner);
    db.write(owner, 0, original);
    raw.exec(
      "CREATE TRIGGER fail_workspace BEFORE UPDATE ON workspace BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;",
    );
    expect(() =>
      db.write(owner, 1, emptyWorkspace(), "Before failed import"),
    ).toThrow("simulated disk failure");
    expect(db.read().data).toEqual(original);
    expect(db.revision()).toBe(1);
    expect(db.snapshot()).toBeNull();
  } finally {
    raw.close();
    db.close();
  }
});

test("final close saves cannot overwrite a different owner and supersede this client's older autosaves", async ({}, info) => {
  const db = new LocalDatabase(info.outputPath("final-save.sqlite"));
  const first = uid(),
    second = uid(),
    original = fixture("Original"),
    newer = fixture("New owner");
  try {
    db.acquire(first);
    db.write(first, 0, original);
    db.release(first);
    db.acquire(second);
    db.write(second, 1, newer);
    db.release(second);
    db.acquire(first);
    db.release(first, original, 1);
    expect(db.read().data).toEqual(newer);
    db.acquire(first);
    db.write(first, 2, original);
    const latest = fixture("Latest same-owner draft");
    db.release(first, latest, 2);
    expect(db.read().data).toEqual(latest);
    expect(db.acquire(second).owned).toBe(true);
  } finally {
    db.close();
  }
});

test("independent browser profiles share data and transfer editing without overwriting their old browser copies", async ({
  page,
  browser,
}) => {
  const w = fixture();
  await page.addInitScript((data) => {
    if (window === window.top) {
      localStorage.setItem("orvane.examples.v1", "installed");
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
    }
  }, w);
  await page.goto("/");
  await expect(page.locator("main")).toHaveAttribute("data-editable", "true");
  const other = await browser.newContext(),
    second = await other.newPage();
  const unrelated = fixture("Older browser-only data");
  await second.addInitScript((data) => {
    if (window === window.top)
      localStorage.setItem("orvane.workspace.v1", JSON.stringify(data));
  }, unrelated);
  try {
    await second.goto("/");
    await expect(second.locator(".dock-tab")).toContainText("Shared workspace");
    await expect(second.locator("main")).toHaveAttribute(
      "data-editable",
      "false",
    );
    await page
      .getByRole("button", { name: "Increase Count", exact: true })
      .click();
    await expect(second.locator("output")).toHaveText("1");
    expect(
      await second.evaluate(
        () =>
          JSON.parse(localStorage.getItem("orvane.workspace.v1")!).apps[0].name,
      ),
    ).toBe("Older browser-only data");
    await page.close();
    await expect(second.locator("main")).toHaveAttribute(
      "data-editable",
      "true",
    );
    await second
      .getByRole("button", { name: "Increase Count", exact: true })
      .click();
    await expect
      .poll(async () => (await readStored(second)).apps[0]!.blocks[0]!.count)
      .toBe(2);
    await second.getByRole("button", { name: "Workspace options" }).click();
    await second
      .getByRole("button", { name: "Recover earlier browser workspace" })
      .click();
    await expect(
      second.getByRole("dialog", { name: "Backup import preview" }),
    ).toBeVisible();
    await second.getByRole("button", { name: "Cancel import" }).click();
    expect((await readStored(second)).apps).toHaveLength(1);
  } finally {
    await other.close();
  }
});

test("existing IndexedDB migrates into SQLite and its original records remain untouched", async ({
  page,
}) => {
  const w = fixture("IndexedDB source");
  await page.goto("/__orvane/storage/revision");
  await page.evaluate(async (data) => {
    localStorage.setItem("orvane.examples.v1", "installed");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("orvane", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("workspace", { keyPath: "id" });
        request.result.createObjectStore("snapshots", {
          keyPath: "id",
          autoIncrement: true,
        });
        request.result.createObjectStore("preferences", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("workspace", "readwrite");
      transaction
        .objectStore("workspace")
        .put({ id: "current", data, revision: 7 });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, w);
  await page.goto("/");
  await expect(page.locator(".dock-tab")).toContainText("IndexedDB source");
  await page
    .getByRole("button", { name: "Increase Count", exact: true })
    .click();
  await expect
    .poll(async () => (await readStored(page)).apps[0]!.blocks[0]!.count)
    .toBe(1);
  expect(
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open("orvane");
        r.onsuccess = () => resolve(r.result);
      });
      return new Promise<number>((resolve) => {
        const r = db
          .transaction("workspace")
          .objectStore("workspace")
          .get("current");
        r.onsuccess = () => {
          resolve(r.result.data.apps[0].blocks[0].count);
          db.close();
        };
      });
    }),
  ).toBe(0);
});

test("storage API rejects cross-origin and opaque-origin requests and database downloads", async ({
  page,
}) => {
  for (const origin of ["https://untrusted.example", "null"]) {
    const response = await page.request.get("/__orvane/storage/state", {
      headers: { Origin: origin },
    });
    expect(response.status()).toBe(403);
    const mutation = await page.request.post("/__orvane/storage/lease", {
      headers: { Origin: origin },
      data: { client: uid() },
    });
    expect(mutation.status()).toBe(403);
  }
  expect(
    (await page.request.get("/.orvane/workspace.sqlite")).status(),
  ).not.toBe(200);
  expect(
    (
      await page.request.post("/__orvane/storage/lease", {
        headers: { "Content-Type": "text/plain" },
        data: JSON.stringify({ client: uid() }),
      })
    ).status(),
  ).toBe(415);
});
