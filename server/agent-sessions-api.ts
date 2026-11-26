import type { Plugin, Connect } from "vite";
import type { ServerResponse } from "node:http";
import { extname, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { SessionTranscripts } from "./session-transcripts.ts";
import { AgentRunner } from "./agent-runner.ts";
import { claudeModels, codexModels, findAgent, type AgentCommand } from "./agent-cli.ts";
import { listSkills, SavedPrompts } from "./agent-skills.ts";
import { AgentSchedules } from "./agent-schedules.ts";
import { mcpInstall, mcpRemove, mcpSetup, mcpStatus, mcpTest, type McpSetup } from "./agent-mcp.ts";
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
import { hostNotes } from "./orvane-host-notes.ts";
import {
  ClaudeProfiles,
  claudeAuthStatus,
  DEFAULT_PROFILE,
  profileIdPattern,
  type ClaudeAuth,
  type ResolvedProfile,
} from "./claude-profiles.ts";
import { ClaudeTranscriptSet } from "./claude-transcripts.ts";
import { cancelLogin, issueLogin, loginActive, loginTicket } from "./claude-login.ts";
import type { AgentProvider } from "../src/agentSessions.ts";

/** Pictures an agent shows in a reply with ![caption](path). No SVG: it can carry script. */
export const REPLY_PICTURE_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp",
};
const MAX_REPLY_PICTURE = 30 * 1024 * 1024;
/** Streams a local picture for a reply, or answers why it cannot. */
export async function sendReplyPicture(path: string, res: ServerResponse, reply: (status: number, value: unknown) => void) {
  const type = REPLY_PICTURE_TYPES[extname(path).toLowerCase()];
  if (!isAbsolute(path) || !type) return reply(400, { error: "Not a picture file." });
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return reply(404, { error: "Picture was not found." });
  if (info.size > MAX_REPLY_PICTURE) return reply(413, { error: "Picture is too large." });
  // Screenshots are often rewritten under the same name: always revalidate.
  res.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Cache-Control": "no-cache",
    "Last-Modified": info.mtime.toUTCString(), "X-Content-Type-Options": "nosniff" });
  createReadStream(path).on("error", () => res.destroy()).pipe(res);
}



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
/** A Claude account ID; the server resolves it, the page never sends folders or env. */
const profileId = z.string().regex(profileIdPattern, "Choose a Claude account.");
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
      profileId: profileId.optional(),
      folder: z.string().min(1).max(2000).optional(),
      model,
      effort,
      mode,
    }),
  ]),
});

/** One Claude account as Settings and the pickers see it (no secrets). */
type ProfileView = {
  id: string;
  name: string;
  color: string;
  folder: string;
  isDefault: boolean;
  inherited: boolean;
  generated: boolean;
  removed: boolean;
  newChats: boolean;
  running: number;
  signingIn: boolean;
  sessions: number;
  mcp: boolean;
  auth: Pick<ClaudeAuth, "loggedIn" | "supported" | "email" | "plan" | "error" | "checkedAt"> | null;
  usage: import("../src/agentSessions.ts").AgentUsage | null;
};

export function agentSessionsApi(directory: string): Plugin {
  type Service = {
    claude: ClaudeTranscriptSet;
    codex: SessionTranscripts;
    runner: AgentRunner;
    delegations: AgentDelegations;
    surveying: string;
    prompts: SavedPrompts;
    schedules: AgentSchedules;
    skillsHome: (provider: AgentProvider, profile?: ResolvedProfile) => string;
    usage: AgentUsageStore;
    codexSessions: string;
    profiles: ClaudeProfiles;
    /** Last sign-in each account reported (memory only, non-secret). */
    auth: Map<string, ClaudeAuth>;
    checking: Map<string, Promise<void>>;
    command: (provider: AgentProvider) => AgentCommand;
    /** Model lists per Codex and per Claude account. */
    catalogues: Map<string, { time: number; request: Promise<{ value: string; label: string }[]> }>;
    namespace: string;
    dir: string;
  };
  const services = new Map<string, Service>();

  let testing = false;
  const hostControllers = new Map<string, HostSettings>();
  let scheduler: ReturnType<typeof setInterval> | undefined;
  /** An account's sign-in changed: its usage and model list no longer apply. */
  function recordAuth(service: Service, id: string, auth: ClaudeAuth) {
    const before = service.auth.get(id);
    if (before && before.fingerprint !== auth.fingerprint) service.catalogues.delete(`claude:${id}`);
    const saved = service.usage.claude(id);
    if (saved && saved.fingerprint !== auth.fingerprint) service.usage.dropClaude(id);
    service.auth.set(id, auth);
  }
  async function checkAuth(service: Service, id: string) {
    const pending = service.checking.get(id);
    if (pending) return pending;
    const check = (async () => {
      try {
        const profile = service.profiles.resolveForRead(id);
        recordAuth(service, id, await claudeAuthStatus(service.command("claude"), profile, service.dir));
      } catch (error) {
        const before = service.auth.get(id);
        service.auth.set(id, {
          loggedIn: false,
          supported: false,
          error: error instanceof Error ? error.message : "Could not check sign-in.",
          checkedAt: Date.now(),
          fingerprint: before?.fingerprint ?? "",
        });
      }
    })().finally(() => service.checking.delete(id));
    service.checking.set(id, check);
    return check;
  }
  /** The trusted, active account for a run; never a silent fallback. */
  function runProfile(service: Service, id: string | undefined) {
    if (!id) throw Error("Choose a Claude account for this chat.");
    return service.profiles.resolve(id);
  }
  async function hasMcp(file: string) {
    try {
      const config = JSON.parse(await readFile(file, "utf8"));
      return !!config?.mcpServers?.orvane;
    } catch {
      return false;
    }
  }
  async function profileViews(service: Service): Promise<ProfileView[]> {
    const { profiles, runner } = service;
    const newChat = profiles.newChatProfileId;
    const usage = service.usage.claudeAll();
    return Promise.all(
      profiles.list().map(async (p) => {
        const resolved = profiles.resolveForRead(p.id);
        const auth = service.auth.get(p.id);
        const stored = usage[p.id];
        return {
          id: p.id,
          name: p.name,
          color: p.color,
          folder: resolved.effectiveDir,
          isDefault: p.id === DEFAULT_PROFILE,
          inherited: p.configDir === null,
          generated: !!p.generated,
          removed: !!p.removedAt,
          newChats: p.id === newChat,
          running: runner.busyCount(p.id),
          signingIn: loginActive(service.namespace, p.id),
          sessions: (await service.claude.of(p.id).list().catch(() => [])).length,
          mcp: await hasMcp(resolved.claudeFile),
          auth: auth
            ? {
                loggedIn: auth.loggedIn,
                supported: auth.supported,
                ...(auth.email ? { email: auth.email } : {}),
                ...(auth.plan ? { plan: auth.plan } : {}),
                ...(auth.error ? { error: auth.error } : {}),
                checkedAt: auth.checkedAt,
              }
            : null,
          // Only limits reported for the sign-in the account has now.
          usage: stored && auth?.loggedIn && auth.supported && stored.fingerprint === auth.fingerprint ? stored.usage : null,
        };
      }),
    );
  }
  function mcpFor(service: Service, profile?: ResolvedProfile): McpSetup {
    const dir = service.dir;
    const base = testing
      ? {
          ...mcpSetup(dir),
          claudeFile: join(dir, ".claude.json"),
          // The test CLI fixture plays both CLIs' `mcp` commands.
          cli: (provider: AgentProvider) => {
            const file = join(dir, "agent-cli.cjs");
            if (!existsSync(file)) throw Error("No test CLI fixture is installed.");
            return { file: process.execPath, args: [file, "--mcp-provider", provider] };
          },
        }
      : mcpSetup(directory);
    if (!profile) return base;
    const home = homedir();
    return {
      ...base,
      claudeFile: profile.claudeFile,
      env: profile.env,
      claudeWhere: profile.claudeFile.toLowerCase().startsWith(home.toLowerCase())
        ? `~${profile.claudeFile.slice(home.length).replace(/\\/g, "/")}`
        : profile.claudeFile,
    };
  }
  function serviceFor(namespace: string) {
    let service = services.get(namespace);
    if (!service) {
      const dir = testing ? join(directory, "tests", namespace) : directory;
      const command = testing
        ? () => {
            const file = join(dir, "agent-cli.cjs");
            if (!existsSync(file))
              throw Error("No test CLI fixture is installed.");
            return { file: process.execPath, args: [file] };
          }
        : findAgent;
      const workspaceFile = join(directory, testing ? `tests/${namespace}.sqlite` : "workspace.sqlite");
      const profiles = new ClaudeProfiles(workspaceFile, {
        home: testing ? join(dir, "claude-profiles") : join(homedir(), ".claude-profiles"),
        ...(testing
          ? {
              defaultProjects: join(dir, "claude-projects"),
              defaultClaudeFile: join(dir, ".claude.json"),
              defaultSkills: join(dir, ".claude", "skills"),
              forbidden: [join(dir, "agent-runs")],
            }
          : { forbidden: [directory, process.cwd()] }),
      });
      const claude = new ClaudeTranscriptSet(dir, () =>
        profiles.list().map((p) => {
          const resolved = profiles.resolveForRead(p.id);
          return { id: p.id, root: resolved.projectsRoot, configDir: resolved.effectiveDir };
        }),
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
        command,
      );
      const usage = new AgentUsageStore(workspaceFile);
      runner.onClaudeUsage = (event, id, fingerprint) => {
        const reported = claudeUsage(event);
        if (reported) usage.saveClaude(id, fingerprint, reported);
      };
      runner.loginActive = (id) => loginActive(namespace, id);
      runner.validateProfile = (id) => { profiles.resolve(id); };
      runner.resumePath = (profile, sessionId, key) => claude.resumePath(profile.id, sessionId, profile.name, key);
      runner.onAuth = (id, auth) => {
        recordAuth(service!, id, auth);
        if (auth.loggedIn && auth.supported) profiles.markUsed(id);
      };
      service = {
        namespace,
        dir,
        command,
        profiles,
        auth: new Map(),
        checking: new Map(),
        catalogues: new Map(),
        usage,
        delegations: new AgentDelegations(workspaceFile, dir, runner, async (provider, id) => {
          const sessions = await (provider === "codex" ? codex : claude.of(DEFAULT_PROFILE)).list();
          return sessions.find((session) => session.sessionId === id)?.key;
        }, (target) => target.provider === "claude" ? { ...target, profile: profiles.resolve(DEFAULT_PROFILE) } : target),
        codexSessions: testing
          ? join(dir, "codex-sessions")
          : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
        claude,
        codex,
        runner,
        prompts: new SavedPrompts(workspaceFile),
        schedules: new AgentSchedules(
          workspaceFile,
          // A pinned account that was removed fails the run with its reason.
          ({ profileId: pinned, ...target }, message) =>
            runner.start(
              target.provider === "claude" ? { ...target, profile: profiles.resolve(pinned ?? "") } : target,
              message,
            ),
          (id) => runner.inspect(id),
        ),
        skillsHome: (provider, profile) =>
          provider === "claude"
            ? (profile ?? profiles.resolveForRead(DEFAULT_PROFILE)).skills
            : testing
              ? join(dir, ".codex", "skills")
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
    const agents = hostAgentGateway(chat, {
      claude: { list: () => service.claude.all(), find: (key) => service.claude.forKey(key).find(key) },
      codex: service.codex,
    }, service.runner,
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
      settings = new HostSettings(data.data, data.file, (projects, approvals, maker, terminal, browserOrigin, desktopOrigin, notes) => ({
        recent: () => serviceFor(namespace).runner.recent(),
        ...hostChat(namespace, projects, approvals),
        ...(maker ? { maker: new UiMakerService(directory, data.filename) } : {}),
        terminal,
        ...(browserOrigin ? { browser: new HostBrowser(bridges, browserOrigin) } : {}),
        ...(desktopOrigin ? { desktop: new HostDesktop(bridges, desktopOrigin) } : {}),
        ...(notes ? { notes: hostNotes(directory, data.filename) } : {}),
      }));
      hostControllers.set(namespace, settings);
    }
    return settings;
  }
  /** Agent sessions → Settings → Claude accounts. */
  async function accountOp(service: Service, op: string, args: Record<string, unknown>) {
    const { profiles, runner, schedules, namespace } = service;
    const id = () => profileId.parse(args.id);
    const list = async () => ({
      profiles: await profileViews(service),
      newChatProfileId: profiles.newChatProfileId,
      draft: profiles.draft(),
    });
    switch (op) {
      case "claude-profiles": {
        // Sign-in status comes from `claude auth status` per account (local,
        // nothing is sent to check usage); re-read on Check or once a minute.
        const stale = profiles
          .list()
          .filter((p) => !p.removedAt)
          .filter((p) => args.check === true || !service.auth.get(p.id) || Date.now() - service.auth.get(p.id)!.checkedAt > 60_000);
        if (stale.length) await Promise.all(stale.map((p) => checkAuth(service, p.id)));
        return list();
      }
      case "claude-profile-check":
        await checkAuth(service, id());
        return list();
      case "claude-profile-add": {
        const input = z
          .object({ id: profileId, name: z.string().trim().min(1).max(40), folder: z.string().max(2000).optional() })
          .parse(args);
        const added = await profiles.add(input);
        await checkAuth(service, added.id);
        return { ...(await list()), added: added.id };
      }
      case "claude-profile-rename":
        profiles.rename(id(), z.string().max(40).parse(args.name));
        return list();
      case "claude-profile-new-chats":
        profiles.setNewChat(id());
        return list();
      case "claude-profile-remove": {
        const target = id();
        profiles.remove(target, {
          running: runner.busyCount(target),
          signingIn: loginActive(namespace, target),
          schedules: schedules.usingProfile(target),
        });
        service.auth.delete(target);
        service.catalogues.delete(`claude:${target}`);
        return list();
      }
      case "claude-profile-login": {
        const target = id();
        const profile = profiles.resolve(target);
        // Signing in again rewrites the folder's credentials: never while a
        // chat of this account runs. Runs check loginActive the other way.
        const running = runner.busyCount(target);
        if (running)
          throw Error(`${profile.name} has ${running} running chat${running === 1 ? "" : "s"}. Sign in again when ${running === 1 ? "it finishes" : "they finish"}.`);
        const ticket = issueLogin(namespace, target, profile.name, service.command("claude"), profile.env, service.dir, () => {
          // The CLI wrote (or didn't write) its sign-in: read it fresh.
          service.catalogues.delete(`claude:${target}`);
          void checkAuth(service, target);
        });
        return { ticket, name: profile.name };
      }
      case "claude-profile-login-show": {
        const ticket = loginTicket(namespace, id());
        if (!ticket) throw Error("No sign-in is open for this account.");
        return { ticket };
      }
      case "claude-profile-login-cancel":
        cancelLogin(namespace, id());
        return list();
      default:
        throw Error("Unknown account operation.");
    }

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
      if (op === "picture") return await sendReplyPicture(url.searchParams.get("path") ?? "", res, reply);

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
        value.startsWith("codex:") ? codex : claude.forKey(value);
      const { profiles } = service;
      /** Optional account for reads and text jobs: missing means New chats. */
      const chosenProfile = (value: unknown) =>
        profiles.resolve(value === undefined ? profiles.newChatProfileId : profileId.parse(value));
      if (op.startsWith("claude-profile")) return reply(200, await accountOp(service, op, args));
      if (op === "sessions") {
        const lists = await Promise.all([claude.all(), codex.list()]);
        return reply(200, {
          sessions: lists.flat().sort((a, b) => b.updatedAt - a.updatedAt),
          runs: runner.recent(),
        });
      }
      if (op === "slash") {
        const { provider, folder, profileId: account } = z
          .object({
            provider: z.enum(["claude", "codex"]),
            folder: z.string().max(2000).optional(),
            profileId: profileId.optional(),
          })
          .parse(args);
        // Skills come from the chat's own account folder.
        const profile = provider === "claude" ? profiles.resolveForRead(account ?? profiles.newChatProfileId) : undefined;
        return reply(200, {
          items: await listSkills(provider, skillsHome(provider, profile), folder),
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
        return reply(200, await runner.approvals(
          z.string().min(1).max(200).parse(args.sessionId),
          args.profileId === undefined ? undefined : profileId.parse(args.profileId),
          z.enum(["claude", "codex"]).default("claude").parse(args.provider),
        ));
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
          // Not a chat: it runs on the New chats account.
          const result = await runner.rewrite(chosenProfile(undefined), tmpdir(), JSON.stringify(input), abort.signal);
          if (!res.destroyed) return reply(200, result);
          return;
        } finally {
          res.off("close", cancel);
        }
      }
      if (op === "usage") {
        // Each Claude account's own last reported limits; `claude` is the
        // asked account's (the chat's, or New chats).
        const views = await profileViews(service);
        const asked = args.profileId === undefined ? profiles.newChatProfileId : profileId.parse(args.profileId);
        return reply(200, {
          claude: views.find((v) => v.id === asked)?.usage ?? null,
          claudeProfile: views.find((v) => v.id === asked)?.name ?? null,
          claudeProfiles: Object.fromEntries(views.map((v) => [v.id, v.usage])),
          codex: (await readCodexUsage(service.codexSessions).catch(() => undefined)) ?? null,
        });
      }
      if (op.startsWith("mcp-")) {
        // Claude: one row per active account, each with its own .claude.json
        // and env, so nothing touches another account's config.
        const rows = async () => {
          const accounts = profiles.list().filter((p) => !p.removedAt);
          const claudeRows = await Promise.all(
            accounts.map(async (p) => {
              const [row] = await mcpStatus(mcpFor(service, profiles.resolve(p.id)), ["claude"]);
              return { ...row!, profileId: p.id, profileName: p.name };
            }),
          );
          return [...claudeRows, ...(await mcpStatus(mcpFor(service), ["codex"]))];
        };
        if (op === "mcp-status") return reply(200, { rows: await rows() });
        const provider = z.enum(["claude", "codex"]).parse(args.provider);
        const setup = provider === "claude"
          ? mcpFor(service, profiles.resolve(args.profileId === undefined ? DEFAULT_PROFILE : profileId.parse(args.profileId)))
          : mcpFor(service);
        if (op === "mcp-test") return reply(200, await mcpTest(setup, provider));
        if (op === "mcp-install") await mcpInstall(setup, provider);
        else if (op === "mcp-remove") await mcpRemove(setup, provider);
        else return reply(404, { error: "Unknown MCP operation." });
        return reply(200, { rows: await rows() });
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
        // Claude lists what each account's own sign-in offers.
        const profile = provider === "claude" ? chosenProfile(args.profileId) : undefined;
        if (testing)
          return reply(200, {
            models: provider === "claude"
              ? [{ value: "fable", label: "Fable 5.2" }]
              : [{ value: "test-codex", label: "Test Codex model" }],
          });
        const cacheKey = profile ? `claude:${profile.id}` : provider;
        let catalogue = service.catalogues.get(cacheKey);
        if (!catalogue || Date.now() - catalogue.time > 60_000) {
          catalogue = {
            time: Date.now(),
            request: Promise.resolve()
              .then(() => (profile ? claudeModels({ ...profile.env }) : codexModels()))
              .catch(() => []),
          };
          service.catalogues.set(cacheKey, catalogue);
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
              profileId: data.session.profileId,
            }),
          });
        return reply(200, data);
      }
      if (op === "start") {
        const { target, message } = start.parse(args);
        if ("key" in target) {
          const session = await transcripts(target.key).find(target.key);
          const claudeSession = (session.provider ?? "claude") === "claude";
          return reply(
            202,
            await runner.start(
              {
                key: session.key,
                provider: session.provider ?? "claude",
                // The account whose folder holds this transcript; a removed
                // account fails closed instead of moving the chat.
                ...(claudeSession ? { profile: runProfile(service, session.profileId ?? DEFAULT_PROFILE) } : {}),
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
        const { profileId: account, ...fresh } = target;
        if (fresh.provider !== "claude" && account) throw Error("Only Claude chats use Claude accounts.");
        const profile = fresh.provider === "claude" ? runProfile(service, account) : undefined;
        if (!fresh.folder) await mkdir(surveying, { recursive: true });
        return reply(
          202,
          await runner.start(
            { ...fresh, ...(profile ? { profile } : {}), folder: fresh.folder ?? surveying },
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
          .object({ message: z.string().max(12_000), reply: z.string().trim().min(1).max(40_000), profileId: profileId.optional() })
          .parse(args);
        const abort = new AbortController();
        const cancel = () => abort.abort();
        res.once("close", cancel);
        try {
          // The reply's end says most about what comes next.
          // Suggested on the chat's own account.
          const text = await runner.suggest(
            chosenProfile(input.profileId),
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
          checkpoints: await runner.sessionCheckpoints(
            z.string().min(1).max(200).parse(args.sessionId),
            args.profileId === undefined ? undefined : profileId.parse(args.profileId),
            z.enum(["claude", "codex"]).default("claude").parse(args.provider),
          ),
        });
      if (op === "checkpoint-preview" || op === "checkpoint-restore") {
        const { sessionId, commit, provider, profileId: account } = z
          .object({
            sessionId: z.string().min(1).max(200),
            commit: z.string().regex(/^[0-9a-f]{40}$/),
            provider: z.enum(["claude", "codex"]),
            profileId: profileId.optional(),
          })
          .parse(args);
        const found = (await runner.sessionCheckpoints(sessionId, provider === "claude" ? account ?? DEFAULT_PROFILE : undefined, provider))
          .find((item) => item.commit === commit);
        if (!found?.folder) throw Error("That checkpoint is not part of this session.");
        if (op === "checkpoint-preview")
          return reply(200, await runner.checkpoints.preview(found.folder, commit));
        const current = runner.current({ provider, sessionId, profileId: account });
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
      if (op === "schedule-save") {
        // A Claude prompt is pinned to an existing account (New chats when unset).
        const input = { ...args };
        if (input.provider === "claude") {
          input.profileId = input.profileId === undefined ? profiles.newChatProfileId : profileId.parse(input.profileId);
          profiles.resolve(input.profileId);
        }
        return reply(200, { schedules: schedules.save(input) });
      }
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
    const picture = (op === "attachment" || op === "picture") && req.method === "GET";
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
    for (const { claude, codex, runner, prompts, schedules, delegations, profiles, usage } of services.values()) {

      prompts.close();
      schedules.close();
      delegations.close();
      runner.close();
      claude.close();
      codex.close();
      profiles.close();
      usage.close();
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
