import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { brokerError } from "./netsuite-broker-protocol.mjs";
import { netSuiteReadOperations } from "../server/netsuite-read-operations.ts";

const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
/** Metadata only: no SQL text, tokens, row data, or remote error messages. */
export function openRequestJournal(
  directory,
  instanceId,
  { retention = 1000 } = {},
) {
  if (!Number.isSafeInteger(retention) || retention < 1 || retention > 10000)
    throw Error("Invalid journal retention.");
  const path = join(directory, "requests.sqlite");
  const db = new Database(path);
  try {
    const version = db
      .prepare("SELECT sqlite_version() AS version")
      .get()
      .version.split(".")
      .map(Number);
    if (
      version[0] < 3 ||
      (version[0] === 3 &&
        (version[1] < 53 || (version[1] === 53 && version[2] < 4)))
    )
      throw Error("SQLite 3.53.4 or newer is required for the broker journal.");
    if (db.pragma("user_version", { simple: true }) > 1)
      throw Error("This broker journal requires a newer application version.");
    db.pragma("trusted_schema = OFF");
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec(`CREATE TABLE IF NOT EXISTS requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
      instance_id TEXT NOT NULL, operation TEXT NOT NULL, input_hash TEXT NOT NULL,
      target_hash TEXT, origin TEXT, state TEXT NOT NULL CHECK(state IN ('running','completed','failed','interrupted')),
      started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT
    ); CREATE INDEX IF NOT EXISTS requests_state ON requests(state);
    PRAGMA user_version = 1;`);
    chmodSync(path, 0o600);
    // Called only after exclusive live gateway ownership has been claimed.
    db.prepare(
      "UPDATE requests SET state='interrupted', finished_at=?, error_code='BROKER_INTERRUPTED' WHERE state='running'",
    ).run(new Date().toISOString());
  } catch (error) {
    db.close();
    throw error;
  }
  const prune = db.prepare(
    "DELETE FROM requests WHERE state != 'running' AND sequence NOT IN (SELECT sequence FROM requests ORDER BY sequence DESC LIMIT ?)",
  );
  const begin = db.prepare(
    "INSERT INTO requests(request_id,instance_id,operation,input_hash,target_hash,state,started_at) VALUES(?,?,?,?,?,'running',?)",
  );
  const finish = db.prepare(
    "UPDATE requests SET state=?,finished_at=?,error_code=?,origin=? WHERE request_id=? AND instance_id=? AND state='running'",
  );
  let closed = false;
  const summary = () => ({
    retained: db.prepare("SELECT count(*) AS n FROM requests").get().n,
    running: db
      .prepare("SELECT count(*) AS n FROM requests WHERE state='running'")
      .get().n,
    retention,
    schemaVersion: 1,
  });
  return {
    summary,
    list({ limit = 20, beforeSequence } = {}) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (beforeSequence !== undefined &&
          (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1))
      )
        throw brokerError(
          "INVALID_REQUEST",
          "Request history requires a limit of 1–100 and a positive optional cursor.",
        );
      const rows = db
        .prepare(
          `SELECT sequence,request_id AS requestId,operation,origin,state,
        started_at AS startedAt,finished_at AS finishedAt,error_code AS errorCode FROM requests
        WHERE sequence < ? ORDER BY sequence DESC LIMIT ?`,
        )
        .all(beforeSequence ?? Number.MAX_SAFE_INTEGER, limit + 1);
      const more = rows.length > limit;
      const requests = rows.slice(0, limit);
      return {
        requests,
        nextBeforeSequence: more ? requests.at(-1).sequence : null,
        summary: summary(),
      };
    },
    async run(request, execute) {
      const requestId = randomUUID();
      const operation =
        request?.operation === "query"
          ? "query.select"
          : request?.operation === "read" &&
              Object.hasOwn(netSuiteReadOperations, request.action)
            ? `read.${request.action}`
            : request?.operation === "status" &&
                ["list", "inspect", undefined].includes(request.action)
              ? `status.${request.action || "list"}`
              : "invalid";
      const inputHash = digest(
        JSON.stringify({
          operation,
          sql: request?.sql,
          offset: request?.offset,
          shareInFlight: request?.shareInFlight === true,
          action: request?.action,
          id: request?.id,
          page: request?.page,
        }),
      );
      try {
        begin.run(
          requestId,
          instanceId,
          operation,
          inputHash,
          typeof request?.targetId === "string"
            ? digest(request.targetId)
            : null,
          new Date().toISOString(),
        );
        prune.run(retention);
      } catch {
        throw Object.assign(
          brokerError(
            "JOURNAL_UNAVAILABLE",
            "The request journal could not record intent; no executor call was dispatched.",
          ),
          { requestId },
        );
      }
      try {
        const result = await execute();
        finish.run(
          "completed",
          new Date().toISOString(),
          null,
          result?.origin || null,
          requestId,
          instanceId,
        );
        return { ...result, requestId };
      } catch (error) {
        const code =
          typeof error?.code === "string" &&
          /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
            ? error.code
            : "NETSUITE_ERROR";
        const state = ["BROKER_STOPPED", "EXECUTOR_TIMEOUT"].includes(code)
          ? "interrupted"
          : "failed";
        try {
          finish.run(
            state,
            new Date().toISOString(),
            code,
            null,
            requestId,
            instanceId,
          );
        } catch {
          throw Object.assign(
            brokerError(
              "JOURNAL_UNAVAILABLE",
              "The read outcome could not be recorded.",
            ),
            { requestId },
          );
        }
        throw Object.assign(
          error instanceof Error
            ? error
            : brokerError(code, "NetSuite read failed."),
          { requestId },
        );
      }
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
