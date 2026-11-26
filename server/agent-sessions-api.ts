import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "node:http";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { SessionTranscripts } from "./session-transcripts.ts";
import { AgentRunner } from "./agent-runner.ts";
import { claudeModels, codexModels } from "./agent-cli.ts";
import { listSkills, SavedPrompts } from "./agent-skills.ts";
import { AgentSchedules } from "./agent-schedules.ts";
import { mcpInstall, mcpRemove, mcpSetup, mcpStatus, mcpTest } from "./agent-mcp.ts";
import { AgentUsageStore, claudeUsage, readCodexUsage } from "./agent-usage.ts";
import { agentDelegationSchema } from "../src/agentDelegation.ts";
import { AgentDelegations } from "./agent-delegation.ts";
import { configuredOrvaneHost } from "./orvane-host.ts";
import { defaultModesKey, HostAgentChat } from "./orvane-host-chat.ts";
import { hostAgentGateway } from "./orvane-host-agents.ts";
import { LocalDatabase } from "./database.ts";
import { HostSettings, hostSettingsAction } from "./orvane-host-settings.ts";
import { UiMakerService } from "./uimaker.ts";
import { HostBrowser } from "./orvane-host-browser.ts";
import { HostDesktop } from "./orvane-host-desktop.ts";

const base = "/__orvane/agents/";
const key = z.string().min(1).max(1000);
const id = z.uuid();
const model = z
  .string()
  .max(150)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
  .optional();
const effort = z.enum(["low", "medium", "high", "max"]).optional();
const mode = z.enum(["ask", "auto", "plan", "full"]).optional();
const start = z.object({
  message: z
    .string()
    .max(12_000)
    .refine((text) => !!text.trim(), "Enter a message."),
  target: z.union([
    z.object({
      key,
      model,
      effort,
      mode,
      fork: z.boolean().optional(),
      // Rewound chat (Claude): continue from this transcript message.
      resumeAt: z.string().regex(/^[\da-f-]{36}$/i).optional(),
    }),
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
      delegations: AgentDelegations;
      surveying: string;
      prompts: SavedPrompts;
      schedules: AgentSchedules;
      skillsHome: (provider: "claude" | "codex") => string;
      usage: AgentUsageStore;
      codexSessions: string;
    }
  >();
  let testing = false;
  const hostControllers = new Map<string, HostSettings>();
  let scheduler: ReturnType<typeof setInterval> | undefined;
  const catalogues = new Map<
    "codex" | "claude",
    { time: number; request: ReturnType<typeof codexModels> }
  >();
  function serviceFor(namespace: string) {
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
      const workspaceFile = join(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite");
      const usage = new AgentUsageStore(workspaceFile);
      runner.onClaudeUsage = (event) => {
        const reported = claudeUsage(event);
        if (reported) usage.saveClaude(reported);
      };
      service = {
        usage,
        delegations: new AgentDelegations(workspaceFile, dir, runner, async (provider, id) => {
          const sessions = await (provider === "codex" ? codex : claude).list();
          return sessions.find((session) => session.sessionId === id)?.key;
        }),
        codexSessions: testing
          ? join(dir, "codex-sessions")
          : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
        claude,
        codex,
        runner,
        prompts: new SavedPrompts(workspaceFile),
        schedules: new AgentSchedules(
          workspaceFile,
          (target, message) => runner.start(target, message),
          (id) => runner.inspect(id),
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
    return service;
  }
  function hostChat(namespace: string, projects: string[], approvals: boolean) {
    const service = serviceFor(namespace);
    const chat = new HostAgentChat(projects, workspacePath(namespace).file, approvals);
    const data = workspacePath(namespace).data;
    // The laptop's Agent Sessions page calls the same operations, scoped.
    const agents = hostAgentGateway(chat, service, service.runner,
      (op, args, url, res, reply) => operate(namespace, op, args, url, res, reply),
      data, join(data, "agent-attachments"));
    return { chat, agents };
  }
  function workspacePath(namespace: string) {
    const filename = testing ? `tests/${namespace}.sqlite` : "workspace.sqlite";
    return { filename, file: join(directory, filename), data: testing ? join(directory, "tests", namespace) : directory };
  }
  function hostSettingsFor(namespace: string) {
    let settings = hostControllers.get(namespace);
    if (!settings) {
      const data = workspacePath(namespace);
      const bridges = process.env.ORVANE_MCP_STATE_DIR || fileURLToPath(new URL("../.orvane", import.meta.url));
      settings = new HostSettings(data.data, data.file, (projects, approvals, maker, terminal, browserOrigin, desktopOrigin) => ({
        recent: () => serviceFor(namespace).runner.recent(),
        ...hostChat(namespace, projects, approvals),
        ...(maker ? { maker: new UiMakerService(directory, data.filename) } : {}),
        terminal,
        ...(browserOrigin ? { browser: new HostBrowser(bridges, browserOrigin) } : {}),
        ...(desktopOrigin ? { desktop: new HostDesktop(bridges, desktopOrigin) } : {}),
      }));
      hostControllers.set(namespace, settings);
    }
    return settings;
  }
  type Reply = (status: number, value: unknown) => void;
  /**
   * The session operations themselves, after the caller's access checks. The
   * desktop middleware below and Orvane Host's scoped gateway both use them.
   */
  async function operate(
    namespace: string,
    op: string,
    args: Record<string, any>,
    url: URL,
    res: ServerResponse,
    reply: Reply,
  ): Promise<void> {
      const picture = op === "attachment";
      const streaming = op === "run-events";
      const service = serviceFor(namespace);
      const { claude, codex, runner, surveying, prompts, schedules, skillsHome } = service;
      if (picture) {
        const name = url.searchParams.get("name") ?? "";
        // Only names attachment-save makes: no paths, nothing else on disk.
        if (!/^snapshot-[\w-]{1,80}\.png$/.test(name)) return reply(400, { error: "Unknown picture." });
        const folder = join(testing ? join(directory, "tests", namespace) : directory, "agent-attachments");
        const data = await readFile(join(folder, name)).catch(() => null);
        if (!data) return reply(404, { error: "Picture was not found." });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" });
        res.end(data);
        return;
      }
      if (streaming) {
        if (!runner.subscribe(id.parse(url.searchParams.get("id")), res))
          return reply(404, { error: "Run was not found." });
        return;
      }
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
      if (op === "notes-rewrite") {
        const input = z.object({
          selection: z.string().trim().min(1).max(8_000),
          instruction: z.string().trim().min(1).max(1_500),
          previous: z.string().max(12_000).optional(),
        }).parse(args);
        const abort = new AbortController();
        const cancel = () => abort.abort();
        res.once("close", cancel);
        try {
          const result = await runner.rewrite(tmpdir(), JSON.stringify(input), abort.signal);
          if (!res.destroyed) return reply(200, result);
          return;
        } finally {
          res.off("close", cancel);
        }
      }
      if (op === "usage")
        return reply(200, {
          claude: service.usage.claude() ?? null,
          codex: (await readCodexUsage(service.codexSessions).catch(() => undefined)) ?? null,
        });
      if (op.startsWith("mcp-")) {
        const dir = testing ? join(directory, "tests", namespace) : directory;
        const setup = testing
          ? {
              ...mcpSetup(dir),
              claudeFile: join(dir, ".claude.json"),
              // The test CLI fixture plays both CLIs' `mcp` commands.
              cli: (provider: "claude" | "codex") => {
                const file = join(dir, "agent-cli.cjs");
                if (!existsSync(file)) throw Error("No test CLI fixture is installed.");
                return { file: process.execPath, args: [file, "--mcp-provider", provider] };
              },
            }
          : mcpSetup(directory);
        if (op === "mcp-status") return reply(200, { rows: await mcpStatus(setup) });
        const provider = z.enum(["claude", "codex"]).parse(args.provider);
        if (op === "mcp-test") return reply(200, await mcpTest(setup, provider));
        if (op === "mcp-install") await mcpInstall(setup, provider);
        else if (op === "mcp-remove") await mcpRemove(setup, provider);
        else return reply(404, { error: "Unknown MCP operation." });
        return reply(200, { rows: await mcpStatus(setup) });
      }
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
      if (op === "transcript-file") {
        const value = key.parse(args.key);
        return reply(200, { path: await transcripts(value).file(value) });
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
                fork: (session.provider ?? "claude") === "claude" && (target.fork || !!target.resumeAt),
                ...((session.provider ?? "claude") === "claude" && target.resumeAt
                  ? { resumeAt: target.resumeAt }
                  : {}),
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
      if (op === "queue") {
        const { message, first, steer } = z
          .object({
            message: start.shape.message,
            first: z.boolean().optional(),
            steer: z.boolean().optional(),
          })
          .parse(args);
        const runId = id.parse(args.id);
        const view = runner.enqueue(runId, message, first && !steer);
        // Interrupt: stop now, and the message goes once the run has stopped.
        if (first && !steer) runner.sendQueued(runId, view.queued![0]!.id);
        // Steer: hand it to the working turn; if it can't take it, it stays queued.
        if (steer) {
          try {
            runner.steer(runId, view.queued!.at(-1)!.id);
          } catch (cause) {
            return reply(200, { ...runner.inspect(runId), steerError: (cause as Error).message });
          }
        }
        return reply(200, runner.inspect(runId));
      }
      if (op === "steer")
        return reply(200, runner.steer(id.parse(args.id), z.uuid().parse(args.queueId)));
      if (op === "runs") return reply(200, { runs: runner.recent() });
      if (op === "suggest") {
        const input = z
          .object({ message: z.string().max(12_000), reply: z.string().trim().min(1).max(40_000) })
          .parse(args);
        const abort = new AbortController();
        const cancel = () => abort.abort();
        res.once("close", cancel);
        try {
          // The reply's end says most about what comes next.
          const text = await runner.suggest(
            tmpdir(),
            JSON.stringify({ message: input.message.slice(0, 3000), reply: input.reply.slice(-6000) }),
            abort.signal,
          );
          if (!res.destroyed) return reply(200, { text });
          return;
        } finally {
          res.off("close", cancel);
        }
      }
      if (op === "checkpoints")
        return reply(200, {
          checkpoints: await runner.sessionCheckpoints(z.string().min(1).max(200).parse(args.sessionId)),
        });
      if (op === "checkpoint-preview" || op === "checkpoint-restore") {
        const { sessionId, commit, provider } = z
          .object({
            sessionId: z.string().min(1).max(200),
            commit: z.string().regex(/^[0-9a-f]{40}$/),
            provider: z.enum(["claude", "codex"]),
          })
          .parse(args);
        const found = (await runner.sessionCheckpoints(sessionId)).find((item) => item.commit === commit);
        if (!found?.folder) throw Error("That checkpoint is not part of this session.");
        if (op === "checkpoint-preview")
          return reply(200, await runner.checkpoints.preview(found.folder, commit));
        const current = runner.current({ provider, sessionId });
        if (current && (current.status === "running" || current.status === "stopping"))
          throw Error("Stop the running turn before rewinding files.");
        return reply(200, await runner.checkpoints.restore(found.folder, commit));
      }
      if (op === "attachment-save") {
        const { data } = z
          .object({ data: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(11_900_000) })
          .parse(args);
        const folder = join(testing ? join(directory, "tests", namespace) : directory, "agent-attachments");
        await mkdir(folder, { recursive: true });
        const name = `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}.png`;
        const path = join(folder, name);
        await writeFile(path, Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
        return reply(200, { path });
      }
      if (op === "unqueue")
        return reply(
          200,
          runner.unqueue(id.parse(args.id), z.uuid().parse(args.queueId)),
        );
      if (op === "queue-now")
        return reply(
          200,
          runner.sendQueued(id.parse(args.id), z.uuid().parse(args.queueId)),
        );
      if (op === "schedules") return reply(200, { schedules: schedules.list() });
      if (op === "schedule-save") return reply(200, { schedules: schedules.save(args) });
      if (op === "schedule-delete")
        return reply(200, { schedules: schedules.remove(z.uuid().parse(args.id)) });
      if (op === "schedule-enable")
        return reply(200, {
          schedules: schedules.setEnabled(z.uuid().parse(args.id), z.boolean().parse(args.enabled)),
        });
      if (op === "schedule-run") {
        const view = await schedules.run(z.uuid().parse(args.id));
        return reply(200, { run: view, schedules: schedules.list() });
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
            // AskUserQuestion answers, keyed by question text.
            answers: z.record(z.string().max(2000), z.string().max(20_000)).optional(),
            annotations: z
              .record(
                z.string().max(2000),
                z.object({ notes: z.string().max(20_000).optional(), preview: z.string().max(50_000).optional() }),
              )
              .optional(),
          })
          .parse(args);
        runner.decide(
          decision.id,
          decision.requestId,
          decision.allow,
          decision.answers ? { answers: decision.answers, annotations: decision.annotations } : undefined,
        );
        return reply(200, {});
      }
      return reply(404, { error: "Unknown session operation." });
  }
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
    // A picture saved by attachment-save, shown in the composer and chat.
    const picture = op === "attachment" && req.method === "GET";
    if (
      !streaming &&
      !picture &&
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
    if (op === "host-awake") return reply(200, { keepAwake: hostControllers.get(namespace)?.keepAwake ?? false });
    if (op === "desktop-restart-ready")
      return reply(200, { ready: ![...services.values()].some(({ runner }) => runner.hasActiveTurns()) });
    try {
      if (picture || streaming) return await operate(namespace, op, {}, url, res, reply);
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += Buffer.byteLength(chunk);
        const limit =
          op === "attachment-save"
            ? 12_000_000
            : ["start", "queue", "schedule-save", "notes-rewrite", "suggest", "delegation"].includes(op)
              ? 96_000
              : 16_000;
        if (length > limit)
          return reply(413, { error: "Request is too large." });
        chunks.push(Buffer.from(chunk));
      }
      const args = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (op === "host-settings")
        return reply(200, await hostSettingsFor(namespace).execute(hostSettingsAction.parse(args), `${protocol}://${host}`));
      if (op === "delegation")
        return reply(200, await serviceFor(namespace).delegations.execute(agentDelegationSchema.parse(args)));
      // Settings → Sessions default edit modes, so Host access sends use them too.
      if (op === "default-modes") {
        const modes = z.strictObject({
          claude: z.enum(["ask", "auto", "plan", "full"]).optional(),
          codex: z.enum(["auto", "plan", "full"]).optional(),
        }).parse(args);
        const db = new LocalDatabase(workspacePath(namespace).file);
        try { db.saveAppData(defaultModesKey, modes); } finally { db.close(); }
        return reply(200, { ok: true });
      }
      return await operate(namespace, op, args, url, res, reply);
    } catch (error) {
      if (res.destroyed) return;
      reply(400, {
        error:
          error instanceof Error ? error.message : "Session could not be read.",
      });
    }
  };
  // Scheduled prompts run from here, with or without an open sessions app.
  // Test workspaces start theirs with Run now.
  const startScheduler = () => {
    if (testing || scheduler) return;
    const tick = () => {
      try {
        serviceFor("workspace").schedules.tick();
      } catch (error) {
        console.error("Scheduled prompts could not be checked:", error);
      }
    };
    scheduler = setInterval(tick, 15_000);
    scheduler.unref?.();
    setTimeout(tick, 2_000).unref?.();
  };
  const endChildren = () => {
    for (const { runner } of services.values()) runner.emergencyClose();
  };
  const startHost = () => {
    if (testing) return;
    if (process.env.ORVANE_HOST_ENABLED !== "1") {
      void hostSettingsFor("workspace").restore().catch((error: unknown) => {
        console.error("Orvane Host could not turn back on:", error);
      });
      return;
    }
    void hostSettingsFor("workspace").adopt(async () => {
      const listener = await configuredOrvaneHost(() => serviceFor("workspace").runner.recent(),
        (projects, approvals) => hostChat("workspace", projects, approvals), () => new UiMakerService(directory));
      if (listener) console.info(`Orvane Host listening at ${listener.url}`);
      return listener;
    }, process.env.ORVANE_HOST_KEEP_AWAKE === "1").catch((error: unknown) => {
      console.error("Orvane Host could not start:", error);
    });
  };
  const close = () => {
    clearInterval(scheduler);
    scheduler = undefined;
    for (const host of hostControllers.values())
      void host.close().catch((error) => console.error("Orvane Host could not close:", error));
    hostControllers.clear();
    for (const { claude, codex, runner, prompts, schedules, delegations } of services.values()) {
      prompts.close();
      schedules.close();
      delegations.close();
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
      startScheduler();
      startHost();
      s.httpServer?.once("close", close);
    },
    configurePreviewServer(s) {
      process.once("exit", endChildren);
      s.middlewares.use(middleware);
      startScheduler();
      startHost();
      s.httpServer.once("close", close);
    },
  };
}
