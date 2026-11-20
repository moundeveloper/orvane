// Workspace options → Custom tools: the user's view of the custom tools agents
// saved (server/custom-tools.ts, app_data "mcp:tools"). Local, same-origin
// only, like the Notes API. Connected MCP servers pick up changes within a
// few seconds; a turned-off tool is no longer offered to agents.
import { join } from "node:path";
import type { Connect, Plugin } from "vite";
import { z } from "zod";
import { LocalDatabase } from "./database.ts";
import { CUSTOM_TOOLS_KEY, customToolSchema } from "./custom-tools.ts";

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("save"), tool: z.unknown(), previousName: z.string().max(60).optional() }).strict(),
  z.object({ action: z.literal("remove"), name: z.string().max(60) }).strict(),
  z.object({ action: z.literal("disable"), name: z.string().max(60), value: z.boolean() }).strict(),
]);
type Tool = z.infer<typeof customToolSchema>;

export function customToolsApi(directory: string): Plugin {
  let testing = false;
  const databases = new Map<string, LocalDatabase>();
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/__orvane/custom-tools") return next();
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
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      return reply(415, { error: "JSON is required." });
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing ? req.headers["x-orvane-test-workspace"] || cookie : "workspace";
    if (typeof namespace !== "string" || !/^[\w-]{1,80}$/.test(namespace))
      return reply(400, { error: "An isolated test workspace is required." });
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > 300_000) return reply(413, { error: "The request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      let db = databases.get(namespace);
      if (!db) {
        db = new LocalDatabase(join(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite"));
        databases.set(namespace, db);
      }
      const read = () => ((db!.appData(CUSTOM_TOOLS_KEY) as { tools?: Tool[] } | undefined)?.tools ?? []);
      const write = (tools: Tool[]) => db!.saveAppData(CUSTOM_TOOLS_KEY, { tools });
      const r = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      const tools = read();
      if (r.action === "save") {
        const parsed = customToolSchema.safeParse(r.tool);
        if (!parsed.success)
          throw Error(parsed.error.issues.map((i) => `${i.path.join(".") || "tool"}: ${i.message}`).join("; "));
        const tool = parsed.data;
        const old = tools.find((t) => t.name === (r.previousName ?? tool.name));
        if (tools.some((t) => t.name === tool.name && t !== old)) throw Error(`A custom tool named ${tool.name} already exists.`);
        if (!old && tools.length >= 200) throw Error("At most 200 custom tools.");
        if (tool.steps?.some((s) => s.tool === `custom_${tool.name}`)) throw Error("A custom tool cannot call itself.");
        write([...tools.filter((t) => t !== old), { ...tool, ...(old?.disabled ? { disabled: true } : {}) }]);
      } else if (r.action === "remove") {
        if (!tools.some((t) => t.name === r.name)) throw Error(`No custom tool named ${r.name}.`);
        write(tools.filter((t) => t.name !== r.name));
      } else if (r.action === "disable") {
        const tool = tools.find((t) => t.name === r.name);
        if (!tool) throw Error(`No custom tool named ${r.name}.`);
        if (r.value) tool.disabled = true;
        else delete tool.disabled;
        write(tools);
      }
      reply(200, { tools: read() });
    } catch (error) {
      reply(400, {
        error: error instanceof z.ZodError ? "Invalid custom tools request." : error instanceof Error ? error.message : String(error),
      });
    }
  };
  const close = () => {
    for (const db of databases.values()) db.close();
    databases.clear();
  };
  return {
    name: "orvane-custom-tools-api",
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
