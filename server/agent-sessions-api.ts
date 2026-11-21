import type { Plugin, Connect } from "vite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { SessionTranscripts } from "./session-transcripts.ts";
import { AgentRunner } from "./agent-runner.ts";
import { claudeModels, codexModels } from "./agent-cli.ts";
import { listSkills, SavedPrompts } from "./agent-skills.ts";

const base = "/__orvane/agents/";
const key = z.string().min(1).max(1000);
const id = z.uuid();
const model = z
  .string()
  .max(150)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
  .optional();
const effort = z.enum(["low", "medium", "high", "max"]).optional();
const mode = z.enum(["ask", "auto", "plan"]).optional();
const start = z.object({
  message: z
    .string()
    .max(12_000)
    .refine((text) => !!text.trim(), "Enter a message."),
  target: z.union([
    z.object({ key, model, effort, mode, fork: z.boolean().optional() }),
    z.object({
      provider: z.enum(["claude", "codex"]),
      folder: z.string().min(1).max(2000).optional(),
      model,
      effort,
      mode,
    }),
  ]),
});

export function agentSessionsApi(directory: string): Plugin {
  const services = new Map<
    string,
    {
      claude: SessionTranscripts;
      codex: SessionTranscripts;
      runner: AgentRunner;
      surveying: string;
      prompts: SavedPrompts;
      skillsHome: (provider: "claude" | "codex") => string;
    }
  >();
  let testing = false;
  const catalogues = new Map<
    "codex" | "claude",
    { time: number; request: ReturnType<typeof codexModels> }
  >();
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url?.startsWith(base)) return next();
    res.removeHeader("Access-Control-Allow-Origin");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, value: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    const host = req.headers.host || "",
      protocol = "encrypted" in req.socket ? "https" : "http";
    if (
      !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
      (req.headers.origin && req.headers.origin !== `${protocol}://${host}`) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress || "",
      )
    )
      return reply(403, { error: "Local, same-origin access is required." });
    const url = new URL(req.url, "http://localhost");
    const op = url.pathname.slice(base.length);
    const streaming = op === "run-events" && req.method === "GET";
    if (
      !streaming &&
      (req.method !== "POST" ||
        req.headers["content-type"]?.split(";")[0] !== "application/json")
    )
      return reply(415, { error: "POST application/json is required." });
    const cookie = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("orvane-test-workspace="))
      ?.slice("orvane-test-workspace=".length);
    const namespace = testing
      ? req.headers["x-orvane-test-workspace"] || cookie
      : "workspace";
    if (typeof namespace !== "string" || !/^[-\w]{1,80}$/.test(namespace))
      return reply(400, { error: "An isolated test workspace is required." });
    try {
      let service = services.get(namespace);
      if (!service) {
        const dir = testing ? join(directory, "tests", namespace) : directory;
        const claude = new SessionTranscripts(
          dir,
          testing ? join(dir, "claude-projects") : undefined,
        );
        const codex = new SessionTranscripts(
          dir,
          testing
            ? join(dir, "codex-sessions")
            : join(
                process.env.CODEX_HOME || join(homedir(), ".codex"),
                "sessions",
              ),
          undefined,
          "codex",
        );
        const runner = new AgentRunner(
          dir,
          () => {
            claude.invalidate();
            codex.invalidate();
          },
          testing
            ? () => {
                const file = join(dir, "agent-cli.cjs");
                if (!existsSync(file))
                  throw Error("No test CLI fixture is installed.");
                return { file: process.execPath, args: [file] };
              }
            : undefined,
        );
        service = {
          claude,
          codex,
          runner,
          prompts: new SavedPrompts(
            join(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite"),
          ),
          skillsHome: (provider) =>
            testing
              ? join(dir, provider === "claude" ? ".claude" : ".codex", "skills")
              : provider === "claude"
                ? join(homedir(), ".claude", "skills")
                : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "skills"),
          surveying: testing
            ? join(dir, "Surveying")
            : process.env.ORVANE_SURVEYING_DIR ||
              join(homedir(), "Orvane", "Surveying"),
        };
        services.set(namespace, service);
      }
      const { claude, codex, runner, surveying, prompts, skillsHome } = service;
      if (streaming) {
        if (!runner.subscribe(id.parse(url.searchParams.get("id")), res))
          return reply(404, { error: "Run was not found." });
        return;
      }
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        if (length > (op === "start" ? 96_000 : 16_000))
          return reply(413, { error: "Request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const transcripts = (value: string) =>
        value.startsWith("codex:") ? codex : claude;
      if (op === "sessions") {
        const lists = await Promise.all([claude.list(), codex.list()]);
        return reply(200, {
          sessions: lists.flat().sort((a, b) => b.updatedAt - a.updatedAt),
          runs: runner.recent(),
        });
      }
      if (op === "slash") {
        const { provider, folder } = z
          .object({
            provider: z.enum(["claude", "codex"]),
            folder: z.string().max(2000).optional(),
          })
          .parse(args);
        return reply(200, {
          items: await listSkills(provider, skillsHome(provider), folder),
          prompts: prompts.list(),
        });
      }
      if (op === "save-prompt") {
        const { name, text } = z
          .object({ name: z.string().max(40), text: z.string().max(8000) })
          .parse(args);
        return reply(200, { prompts: prompts.save(name, text) });
      }
      if (op === "delete-prompt") {
        const { name } = z.object({ name: z.string().max(40) }).parse(args);
        return reply(200, { prompts: prompts.remove(name) });
      }
      if (op === "run-changes")
        return reply(200, await runner.changes(id.parse(args.id)));
      if (op === "run-diff")
        return reply(
          200,
          await runner.diff(id.parse(args.id), z.string().min(1).max(2000).parse(args.path)),
        );
      if (op === "session-approvals")
        return reply(200, await runner.approvals(z.string().min(1).max(200).parse(args.sessionId)));
      if (op === "inspect-run")
        return reply(200, runner.inspect(id.parse(args.id)));
      if (op === "launcher") {
        await mkdir(surveying, { recursive: true });
        return reply(200, { surveying });
      }
      if (op === "models") {
        const provider = z
          .enum(["claude", "codex"])
          .default("codex")
          .parse(args.provider);
        if (testing)
          return reply(200, {
            models: provider === "claude"
              ? [{ value: "fable", label: "Fable 5.2" }]
              : [{ value: "test-codex", label: "Test Codex model" }],
          });
        let catalogue = catalogues.get(provider);
        if (!catalogue || Date.now() - catalogue.time > 60_000) {
          const readModels = provider === "claude" ? claudeModels : codexModels;
          catalogue = {
            time: Date.now(),
            request: Promise.resolve()
              .then(readModels)
              .catch(() => []),
          };
          catalogues.set(provider, catalogue);
        }
        return reply(200, { models: await catalogue.request });
      }
      if (op === "read") {
        const data = await transcripts(key.parse(args.key)).read(args);
        if (args.includeRun === true)
          return reply(200, {
            ...data,
            run: runner.current({
              ...data.session,
              provider: data.session.provider ?? "claude",
            }),
          });
        return reply(200, data);
      }
      if (op === "start") {
        const { target, message } = start.parse(args);
        if ("key" in target) {
          const session = await transcripts(target.key).find(target.key);
          return reply(
            202,
            await runner.start(
              {
                key: session.key,
                provider: session.provider ?? "claude",
                folder: session.project,
                sessionId: session.sessionId,
                model: target.model,
                effort: target.effort,
                mode: target.mode,
                fork: (session.provider ?? "claude") === "claude" && target.fork,
              },
              message,
            ),
          );
        }
        if (!target.folder) await mkdir(surveying, { recursive: true });
        return reply(
          202,
          await runner.start(
            { ...target, folder: target.folder ?? surveying },
            message,
          ),
        );
      }
      if (op === "stop") {
        runner.stop(id.parse(args.id));
        return reply(200, {});
      }
      if (op === "permission") {
        const decision = z
          .object({
            id,
            requestId: z.string().min(1).max(300),
            allow: z.boolean(),
          })
          .parse(args);
        runner.decide(decision.id, decision.requestId, decision.allow);
        return reply(200, {});
      }
      return reply(404, { error: "Unknown session operation." });
    } catch (error) {
      reply(400, {
        error:
          error instanceof Error ? error.message : "Session could not be read.",
      });
    }
  };
  const endChildren = () => {
    for (const { runner } of services.values()) runner.emergencyClose();
  };
  const close = () => {
    for (const { claude, codex, runner, prompts } of services.values()) {
      prompts.close();
      runner.close();
      claude.close();
      codex.close();
    }
    services.clear();
    process.off("exit", endChildren);
  };
  return {
    name: "orvane-agent-sessions",
    configResolved(c) {
      testing = c.mode === "test-storage";
    },
    configureServer(s) {
      process.once("exit", endChildren);
      s.middlewares.use(middleware);
      s.httpServer?.once("close", close);
    },
    configurePreviewServer(s) {
      process.once("exit", endChildren);
      s.middlewares.use(middleware);
      s.httpServer.once("close", close);
    },
  };
}
