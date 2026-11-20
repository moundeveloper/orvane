// The NetSuite app's own view of what agents use: account memory (review,
// edit, approve), the account's SuiteCloud workspace and Orvane task runs.
// Local, same-origin only, like the other workspace APIs. Everything written
// here counts as the user's: reviewed, and saved scripts approved.
import type { Connect, Plugin } from "vite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CertificateService } from "./certificates.ts";
import { NetSuiteMemoryStore, accountKey } from "./netsuite-memory.ts";
import { createSuiteCloudWorkspace, sameAccount } from "./suitecloud-workspace.ts";

const account = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);
const kind = z.enum(["note", "script"]);
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("memory-accounts") }).strict(),
  z.object({ action: z.literal("memory"), account }).strict(),
  z.object({ action: z.literal("save-note"), account, text: z.string().max(300), id: z.string().max(20).optional() }).strict(),
  z.object({
    action: z.literal("save-script"), account,
    name: z.string().max(60), description: z.string().max(200),
    params: z.array(z.string().max(30)).max(10).default([]),
    code: z.string().max(100_000),
    previousName: z.string().max(60).optional(),
  }).strict(),
  z.object({ action: z.literal("remove"), account, kind, key: z.string().max(60) }).strict(),
  z.object({ action: z.literal("approve"), account, kind, key: z.string().max(60), value: z.boolean().default(true) }).strict(),
  z.object({ action: z.literal("disable"), account, kind, key: z.string().max(60), value: z.boolean() }).strict(),
  z.object({ action: z.literal("suitecloud"), account, refresh: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("suitecloud-auth"), account, authId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("suitecloud-connect"), account, certificatePairId: z.uuid(), certificateId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("suitecloud-tree"), account }).strict(),
  z.object({ action: z.literal("suitecloud-file"), account, path: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal("suitecloud-deploy"), account, dryRun: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("task-runs"), account }).strict(),
]);

export function netSuiteWorkspaceApi(directory: string): Plugin {
  let testing = false;
  const stores = new Map<string, NetSuiteMemoryStore>();
  const workspace = createSuiteCloudWorkspace(directory);
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/__orvane/netsuite-workspace") return next();
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, data: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(data));
    };
    const host = req.headers.host || "",
      protocol = "encrypted" in req.socket ? "https" : "http";
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `${protocol}://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      req.headers["sec-fetch-site"] === "same-site" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
    )
      return reply(403, { error: "Local, same-origin access is required." });
    if (req.method !== "POST") return reply(405, { error: "POST is required." });
    if (req.headers["content-type"]?.split(";")[0] !== "application/json") return reply(415, { error: "JSON is required." });
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing ? req.headers["x-orvane-test-workspace"] || cookie : "workspace";
    if (typeof namespace !== "string" || !/^[\w-]{1,80}$/.test(namespace)) return reply(400, { error: "An isolated test workspace is required." });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 300_000) return reply(413, { error: "The request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      let store = stores.get(namespace);
      if (!store) {
        store = new NetSuiteMemoryStore(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite");
        stores.set(namespace, store);
      }
      const r = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      // Tests never reach the real SuiteCloud CLI or task file.
      if (testing && "account" in r && (r.action.startsWith("suitecloud") || r.action === "task-runs"))
        return reply(200, r.action === "task-runs" ? { runs: [] } : { accountId: r.account, available: false, cli: null, authIds: [], authId: null, reason: "Not available in tests.", created: false });
      let data: unknown;
      switch (r.action) {
        case "memory-accounts": data = store.accounts(); break;
        case "memory": data = store.read(r.account); break;
        case "save-note": data = store.saveNote(r.account, r.text, "user", r.id); break;
        case "save-script": data = store.saveScript(r.account, r, "user", r.previousName); break;
        case "remove": store.remove(r.account, r.kind, r.key); data = { ok: true }; break;
        case "approve": store.mark(r.account, r.kind, r.key, "approve", r.value); data = { ok: true }; break;
        case "disable": store.mark(r.account, r.kind, r.key, "disable", r.value); data = { ok: true }; break;
        case "suitecloud": data = await workspace.status(r.account, r.refresh === true); break;
        case "suitecloud-auth": data = await workspace.chooseAuth(r.account, r.authId); break;
        case "suitecloud-connect": {
          const certificates = new CertificateService(directory);
          try {
            data = await workspace.connectCertificate(r.account, r.certificatePairId, r.certificateId, certificates);
          } finally {
            certificates.close();
          }
          break;
        }
        case "suitecloud-tree": data = await workspace.tree(r.account); break;
        case "suitecloud-file": data = (await workspace.readFiles(r.account, [r.path], 400_000))[0]; break;
        case "suitecloud-deploy": data = await workspace.cli(r.account, "deploy", { dryRun: r.dryRun }); break;
        case "task-runs": {
          const saved = await readFile(join(directory, "netsuite-broker", "task-runs.json"), "utf8").then(JSON.parse).catch(() => ({ runs: [] }));
          const host = (origin: string) => { try { return new URL(origin).hostname.split(".")[0]!; } catch { return ""; } };
          data = { runs: (saved.runs ?? []).filter((run: { origin: string }) => sameAccount(host(run.origin), accountKey(r.account))).slice(-20).reverse() };
          break;
        }
      }
      reply(200, data);
    } catch (error) {
      reply(400, { error: error instanceof z.ZodError ? "Invalid NetSuite workspace request." : error instanceof Error ? error.message : String(error) });
    }
  };
  const close = () => {
    for (const store of stores.values()) store.close();
    stores.clear();
  };
  return {
    name: "orvane-netsuite-workspace-api",
    configResolved(config) {
      testing = config.mode === "test-storage";
    },
    configureServer(server) {
      server.middlewares.use(middleware);
      server.httpServer?.once("close", close);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      server.httpServer.once("close", close);
    },
  };
}
