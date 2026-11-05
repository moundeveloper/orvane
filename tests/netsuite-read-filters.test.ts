import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { compileNetSuiteRead } from "../server/netsuite-read-operations.ts";

const base = {
  operation: "read",
  targetId: "target",
  identityToken: "identity",
};
function database() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE entity(id INTEGER PRIMARY KEY, entityid TEXT);
    CREATE TABLE script(id INTEGER PRIMARY KEY, scriptid TEXT, name TEXT, scripttype TEXT, owner INTEGER, scriptfile INTEGER);
    CREATE TABLE file(id INTEGER PRIMARY KEY, name TEXT, filesize INTEGER, filetype TEXT, folder INTEGER, lastmodifieddate TEXT, createddate TEXT, description TEXT);
    CREATE TABLE MediaItemFolder(id INTEGER PRIMARY KEY, name TEXT, parent INTEGER, foldertype TEXT, numfolderfiles INTEGER, foldersize INTEGER, lastmodifieddate TEXT, description TEXT, IsTopLevel TEXT);`);
  const file = db.prepare("INSERT INTO file(id,name,folder) VALUES(?,?,?)");
  file.run(10, "O'Reilly %_ notes.js", 1);
  file.run(11, "Other.js", 2);
  file.run(12, "x' OR 1=1 --", 2);
  const folder = db.prepare(
    "INSERT INTO MediaItemFolder(id,name,parent,IsTopLevel) VALUES(?,?,?,?)",
  );
  folder.run(-15, "SuiteScripts", null, "T");
  folder.run(1, "O'Reilly %_", -15, "F");
  folder.run(2, "Other", -15, "F");
  db.prepare("INSERT INTO entity VALUES(?,?)").run(7, "O'Reilly");
  const script = db.prepare("INSERT INTO script VALUES(?,?,?,?,?,?)");
  script.run(1, "customscript_one", "Invoice %_ run", "SCHEDULED", 7, 10);
  script.run(2, "customscript_two", "Invoice cat run", "CLIENT", 7, 11);
  return db;
}

test("script exact/type/substring filters combine on the data source before paging", () => {
  const db = database();
  try {
    const compiled = compileNetSuiteRead({
      ...base,
      action: "scripts",
      page: 2,
      filters: {
        scriptId: "customscript_one",
        scriptType: " scheduled ",
        name: "%_",
        owner: "o'reilly",
      },
    });
    assert.deepEqual(
      db
        .prepare(compiled.sql)
        .all()
        .map((row: any) => row.id),
      [1],
    );
    assert.equal(compiled.offset, 200);
    assert.equal(compiled.descriptor.schemaVersion, 2);
    assert.deepEqual(compiled.descriptor.filterFields, [
      "name",
      "owner",
      "scriptId",
      "scriptType",
    ]);
    const mismatch = compileNetSuiteRead({
      ...base,
      action: "scripts",
      filters: { scriptId: "customscript_one", scriptType: "CLIENT" },
    });
    assert.deepEqual(db.prepare(mismatch.sql).all(), []);
    assert.equal(
      compileNetSuiteRead({
        ...base,
        action: "scripts",
        filters: { name: "Invoice" },
      }).sql.includes("LIMIT"),
      false,
    );
  } finally {
    db.close();
  }
});

test("global File Cabinet searches and scoped name filters treat quotes, percent, underscore and injection-shaped text literally", () => {
  const db = database();
  const ids = (input: object) =>
    db
      .prepare(compileNetSuiteRead({ ...base, ...input }).sql)
      .all()
      .map((row: any) => row.id);
  try {
    assert.deepEqual(
      ids({ action: "find-files", filters: { name: "%_" } }),
      [10],
    );
    assert.deepEqual(
      ids({ action: "find-files", filters: { name: "x' OR 1=1 --" } }),
      [12],
    );
    assert.deepEqual(ids({ action: "find-files", id: 11 }), [11]);
    assert.deepEqual(
      ids({ action: "find-files", id: 11, filters: { name: "notes" } }),
      [],
    );
    assert.deepEqual(
      ids({ action: "files", id: 1, filters: { name: "NOTES" } }),
      [10],
    );
    assert.deepEqual(
      ids({ action: "files", id: 2, filters: { name: "NOTES" } }),
      [],
    );
    assert.deepEqual(
      ids({ action: "find-folders", filters: { name: "o'reilly %_" } }),
      [1],
    );
    assert.deepEqual(ids({ action: "find-folders", id: -15 }), [-15]);
    assert.deepEqual(
      ids({ action: "folders", id: -15, filters: { name: "%_" } }),
      [1],
    );
    assert.deepEqual(
      ids({ action: "folders", filters: { name: "Other" } }),
      [],
    );
  } finally {
    db.close();
  }
});

test("searches require an exact File Cabinet ID or bounded valid criteria; fields cannot leak between action types", () => {
  for (const input of [
    { action: "find-files" },
    { action: "find-folders" },
    { action: "find-files", id: -1 },
    { action: "find-files", id: "10" },
    { action: "find-folders", id: 0 },
    { action: "scripts", filters: {} },
    { action: "scripts", filters: { name: undefined } },
    { action: "scripts", filters: { name: "  " } },
    { action: "scripts", filters: { name: "x".repeat(161) } },
    { action: "scripts", filters: { name: "x;y" } },
    { action: "scripts", filters: { name: "x\u0000y" } },
    { action: "scripts", filters: { where: "1=1" } },
    { action: "scripts", filters: { name: 1 } },
    { action: "deployments", id: 1, filters: { name: "x" } },
    { action: "files", id: 1, filters: { owner: "x" } },
    { action: "find-folders", filters: { scriptId: "x" } },
    { action: "find-files", filters: { name: "x" }, sort: "name;DELETE" },
  ])
    assert.throws(() => compileNetSuiteRead({ ...base, ...input }), {
      code: "INVALID_READ",
    });
});
