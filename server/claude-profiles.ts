// Claude accounts: each one is its own Claude Code config folder
// (CLAUDE_CONFIG_DIR), so several claude.ai subscriptions can run side by side.
// Orvane keeps only a name, a colour and the folder; the CLI owns the sign-in.
//
// "default" is the setup Orvane had before accounts existed: it inherits
// whatever CLAUDE_CONFIG_DIR Orvane itself was started with (set or unset),
// and ORVANE_CLAUDE_PROJECTS_DIR applies to it alone. Added accounts get an
// explicit, absolute, immutable folder.
//
// Nothing here reads credentials. Removing an account only hides it: its
// folder, sign-in and history stay on disk and Orvane never logs out.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalDatabase } from "./database.ts";
import { agentEnvironment } from "./agent-cli.ts";

export const DEFAULT_PROFILE = "default";
const KEY = "claude-profiles";
/** Fixed muted colours from the approved mock, assigned in order. */
export const PROFILE_COLORS = ["#6f8998", "#5f8a74", "#a3927a", "#8a7fa3", "#a37f86", "#7f9ca3", "#8f9a6e", "#9a8470"];
const ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
export const profileIdPattern = ID;

export interface ClaudeProfile {
  id: string;
  name: string;
  color: string;
  /** null only for "default": inherit Orvane's own environment. */
  configDir: string | null;
  createdAt: number;
  /** Set by the first run; the folder can never change afterwards. */
  usedAt?: number;
  /** Soft removal: hidden from pickers, history stays readable. */
  removedAt?: number;
  /** true when Orvane created the folder (empty) under ~/.claude-profiles. */
  generated?: boolean;
}

interface Stored {
  version: 1;
  profiles: ClaudeProfile[];
  newChatProfileId: string;
  /** Default's folders as the Orvane server last resolved them, for the MCP
   * process (whose env belongs to whichever account launched it). */
  defaultSeen?: { configDir: string; projects: string };
}

/** A profile resolved for one run: its env and folders are frozen copies. */
export interface ResolvedProfile {
  readonly id: string;
  readonly name: string;
  /** The folder the CLI uses as its config dir (what auth status should report). */
  readonly effectiveDir: string;
  /** Where its transcripts live. */
  readonly projectsRoot: string;
  /** Where `claude mcp add -s user` writes. */
  readonly claudeFile: string;
  readonly skills: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export interface ProfileOptions {
  /** Where generated folders go (~/.claude-profiles). */
  home: string;
  /** Default's transcript root override (tests, ORVANE_CLAUDE_PROJECTS_DIR). */
  defaultProjects?: string;
  /** Default's .claude.json and skills in tests. */
  defaultClaudeFile?: string;
  defaultSkills?: string;
  /** Folders an account may never use or contain (the data folder, the repo). */
  forbidden?: string[];
}

const win = process.platform === "win32";
const fold = (path: string) => (win ? path.toLowerCase() : path);
/** a equals b or sits inside it (both real, absolute paths). */
export function within(a: string, b: string) {
  const rel = relative(fold(b), fold(a));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** The real path of `path`, or, when it doesn't exist yet, the real path of
 * its nearest existing ancestor with the missing segments appended. */
export async function realOrAncestor(path: string): Promise<string> {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw Error("That folder can't be resolved.");
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Default's config folder, read from the env at this moment. */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
}

/** Sanitised `claude auth status`: never tokens, only what the UI shows. */
export interface ClaudeAuth {
  loggedIn: boolean;
  method?: string;
  email?: string;
  plan?: string;
  configDirectory?: string;
  supported: boolean;
  error?: string;
  checkedAt: number;
  /** Hash of the config folder and sign-in identity; changes drop caches. */
  fingerprint: string;
}

export function authFingerprint(effectiveDir: string, status: { method?: string; email?: string; org?: string; plan?: string }) {
  return createHash("sha256")
    .update([fold(resolve(effectiveDir)), status.method ?? "", status.email ?? "", status.org ?? "", status.plan ?? ""].join("\n"))
    .digest("hex")
    .slice(0, 32);
}

export class ClaudeProfiles {
  private db?: LocalDatabase;
  private adding: Promise<unknown> = Promise.resolve();
  constructor(
    private file: string,
    readonly options: ProfileOptions,
  ) {}
  private database() {
    return (this.db ||= new LocalDatabase(this.file));
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
  /** The stored list; first use writes the Default profile (migration). */
  private read(): Stored {
    const saved = this.database().appData(KEY) as Partial<Stored> | undefined;
    if (saved?.version === 1 && Array.isArray(saved.profiles) && saved.profiles.some((p) => p.id === DEFAULT_PROFILE))
      return saved as Stored;
    const fresh: Stored = {
      version: 1,
      profiles: [{ id: DEFAULT_PROFILE, name: "Default", color: PROFILE_COLORS[0]!, configDir: null, createdAt: Date.now() }],
      newChatProfileId: DEFAULT_PROFILE,
    };
    this.database().saveAppData(KEY, fresh);
    return fresh;
  }
  private write(stored: Stored) {
    this.database().saveAppData(KEY, stored);
  }
  list(): ClaudeProfile[] {
    return this.read().profiles.map((p) => ({ ...p }));
  }
  get newChatProfileId() {
    const stored = this.read();
    const chosen = stored.profiles.find((p) => p.id === stored.newChatProfileId && !p.removedAt);
    return chosen?.id ?? DEFAULT_PROFILE;
  }
  get(id: string) {
    return this.read().profiles.find((p) => p.id === id);
  }
  /** For runs: unknown or removed accounts fail closed, never fall back. */
  resolve(id: string): ResolvedProfile {
    const profile = this.get(id);
    if (!profile) throw Error("That Claude account was not found. Choose another account.");
    if (profile.removedAt)
      throw Error(`The Claude account ${profile.name} was removed from Orvane. Start a new chat on another account.`);
    return this.resolved(profile);
  }
  /** For reading history: removed accounts stay readable. */
  resolveForRead(id: string): ResolvedProfile {
    const profile = this.get(id);
    if (!profile) throw Error("That Claude account was not found.");
    return this.resolved(profile);
  }
  private resolved(profile: ClaudeProfile): ResolvedProfile {
    const base = agentEnvironment();
    if (profile.configDir === null) {
      const effectiveDir = defaultConfigDir();
      const projectsRoot = resolve(this.options.defaultProjects || process.env.ORVANE_CLAUDE_PROJECTS_DIR || join(effectiveDir, "projects"));
      const stored = this.read();
      if (stored.defaultSeen?.configDir !== effectiveDir || stored.defaultSeen.projects !== projectsRoot) {
        stored.defaultSeen = { configDir: effectiveDir, projects: projectsRoot };
        this.write(stored);
      }
      return Object.freeze({
        id: profile.id,
        name: profile.name,
        effectiveDir,
        projectsRoot,
        claudeFile: this.options.defaultClaudeFile ||
          join(process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : homedir(), ".claude.json"),
        skills: this.options.defaultSkills || join(effectiveDir, "skills"),
        // Default keeps the inherited env exactly (CLAUDE_CONFIG_DIR set or unset).
        env: Object.freeze(base),
      });
    }
    const env: NodeJS.ProcessEnv = { ...base };
    for (const key of Object.keys(env))
      if (/^(CLAUDE_CONFIG_DIR|ORVANE_CLAUDE_PROJECTS_DIR)$/i.test(key)) delete env[key];
    env.CLAUDE_CONFIG_DIR = profile.configDir;
    return Object.freeze({
      id: profile.id,
      name: profile.name,
      effectiveDir: profile.configDir,
      projectsRoot: join(profile.configDir, "projects"),
      claudeFile: join(profile.configDir, ".claude.json"),
      skills: join(profile.configDir, "skills"),
      env: Object.freeze(env),
    });
  }
  /** A fresh ID and the folder Orvane would create for it. */
  draft() {
    const stored = this.read();
    let id: string;
    do id = `acct-${randomBytes(4).toString("hex")}`;
    while (stored.profiles.some((p) => p.id === id));
    return { id, folder: join(this.options.home, id) };
  }
  /** Every folder an account (or Default) uses, including removed ones. */
  private async takenRoots(stored: Stored) {
    const roots: { name: string; path: string }[] = [];
    for (const p of stored.profiles) {
      const dirs = p.configDir === null
        ? [defaultConfigDir(), ...(this.options.defaultProjects ? [this.options.defaultProjects] : []),
          ...(process.env.ORVANE_CLAUDE_PROJECTS_DIR ? [process.env.ORVANE_CLAUDE_PROJECTS_DIR] : [])]
        : [p.configDir];
      for (const dir of dirs) roots.push({ name: p.name, path: await realOrAncestor(dir) });
    }
    return roots;
  }
  private async check(path: string, stored: Stored) {
    for (const taken of await this.takenRoots(stored))
      if (within(path, taken.path) || within(taken.path, path))
        throw Error(`That folder overlaps the folder of the account ${taken.name}. Use a separate folder.`);
    for (const forbidden of this.options.forbidden ?? []) {
      const real = await realOrAncestor(forbidden);
      if (within(path, real) || within(real, path))
        throw Error("That folder overlaps Orvane's own folders. Use a separate folder.");
    }
  }
  add(input: { id?: string; name: string; folder?: string }) {
    const added = this.adding.then(() => this.addOne(input));
    this.adding = added.catch(() => undefined);
    return added;
  }
  private async addOne(input: { id?: string; name: string; folder?: string }) {
    const stored = this.read();
    const name = input.name.trim().slice(0, 40);
    if (!name) throw Error("Name the account.");
    if (stored.profiles.some((p) => !p.removedAt && p.name.toLowerCase() === name.toLowerCase()))
      throw Error("An account with that name already exists.");
    const id = input.id ?? this.draft().id;
    if (!ID.test(id) || stored.profiles.some((p) => p.id === id)) throw Error("That account ID is not available.");
    const generatedPath = join(this.options.home, id);
    const wanted = input.folder?.trim() ? input.folder.trim() : generatedPath;
    if (!isAbsolute(wanted)) throw Error("Use an absolute folder path.");
    const generated = fold(resolve(wanted)) === fold(resolve(generatedPath));
    let folder: string;
    if (generated) {
      const before = await realOrAncestor(wanted);
      await this.check(before, stored);
      const existing = await stat(wanted).catch(() => null);
      if (existing && (!existing.isDirectory() || (await readdir(wanted)).length))
        throw Error("The new account's folder already exists and isn't empty.");
      await mkdir(wanted, { recursive: true });
      folder = await realpath(wanted);
      try {
        // A junction or link made between the checks must not slip through.
        if (fold(folder) !== fold(before)) throw Error("The folder resolved somewhere else after it was created.");
        await this.check(folder, stored);
      } catch (error) {
        if (!existing) await rmdir(wanted).catch(() => undefined);
        throw error;
      }
    } else {
      // An existing Claude Code folder is used as it is: nothing is copied,
      // emptied or changed, and Orvane never creates it.
      const existing = await stat(wanted).catch(() => null);
      if (!existing?.isDirectory())
        throw Error("That folder doesn't exist. Leave the suggested folder to let Orvane create an empty one.");
      folder = await realpath(wanted);
      await this.check(folder, stored);
    }
    const used = new Set(stored.profiles.filter((p) => !p.removedAt).map((p) => p.color));
    const color = PROFILE_COLORS.find((c) => !used.has(c)) ?? PROFILE_COLORS[stored.profiles.length % PROFILE_COLORS.length]!;
    const profile: ClaudeProfile = { id, name, color, configDir: folder, createdAt: Date.now(), ...(generated ? { generated: true } : {}) };
    await this.check(folder, this.read());
    // Rename/default/remove can run while filesystem checks await. Commit
    // against fresh state with no await between this read and the write.
    const latest = this.read();
    if (latest.profiles.some((p) => p.id === id)) throw Error("That account ID is not available.");
    if (latest.profiles.some((p) => !p.removedAt && p.name.toLowerCase() === name.toLowerCase()))
      throw Error("An account with that name already exists.");
    latest.profiles.push(profile);
    this.write(latest);
    return { ...profile };
  }
  rename(id: string, name: string) {
    const stored = this.read();
    const profile = stored.profiles.find((p) => p.id === id && !p.removedAt);
    if (!profile) throw Error("That Claude account was not found.");
    const clean = name.trim().slice(0, 40);
    if (!clean) throw Error("Name the account.");
    if (stored.profiles.some((p) => p !== profile && !p.removedAt && p.name.toLowerCase() === clean.toLowerCase()))
      throw Error("An account with that name already exists.");
    profile.name = clean;
    this.write(stored);
  }
  setNewChat(id: string) {
    const stored = this.read();
    if (!stored.profiles.some((p) => p.id === id && !p.removedAt)) throw Error("That Claude account was not found.");
    stored.newChatProfileId = id;
    this.write(stored);
  }
  markUsed(id: string) {
    const stored = this.read();
    const profile = stored.profiles.find((p) => p.id === id);
    if (!profile || profile.usedAt) return;
    profile.usedAt = Date.now();
    this.write(stored);
  }
  /** Hides the account. Its folder, sign-in and transcripts stay untouched. */
  remove(id: string, blockers: { running: number; signingIn: boolean; schedules: string[] }) {
    if (id === DEFAULT_PROFILE) throw Error("The Default account can't be removed.");
    const stored = this.read();
    const profile = stored.profiles.find((p) => p.id === id && !p.removedAt);
    if (!profile) throw Error("That Claude account was not found.");
    if (blockers.running)
      throw Error(`${profile.name} has ${blockers.running} running chat${blockers.running === 1 ? "" : "s"}. Let them finish first.`);
    if (blockers.signingIn) throw Error(`A sign-in for ${profile.name} is open. Finish or cancel it first.`);
    if (blockers.schedules.length)
      throw Error(`Scheduled prompts use ${profile.name}: ${blockers.schedules.slice(0, 5).join(", ")}. Move or delete them first.`);
    profile.removedAt = Date.now();
    if (stored.newChatProfileId === id) stored.newChatProfileId = DEFAULT_PROFILE;
    this.write(stored);
  }
}

const subscriptionMethods = new Set(["claude.ai", "oauth", "oauth_token"]);
const text = (value: unknown, max = 200) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * `claude auth status` with this profile's env, reduced to non-secret fields.
 * Fails closed when the CLI reports a different config folder (2.1.268+).
 */
export async function claudeAuthStatus(
  command: { file: string; args: string[] },
  profile: Pick<ResolvedProfile, "effectiveDir" | "env">,
  cwd: string,
): Promise<ClaudeAuth> {
  const { execFile } = await import("node:child_process");
  const output = await new Promise<string>((done, fail) =>
    execFile(
      command.file,
      [...command.args, "auth", "status"],
      { cwd, env: { ...profile.env }, timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (error && (code === "ENOENT" || code === "EACCES" || (error as { killed?: boolean }).killed))
          return fail(Error("Could not start Claude Code to check sign-in."));
        done(String(stdout ?? ""));
      },
    ),
  );
  let status: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(output || "{}");
    if (parsed && typeof parsed === "object") status = parsed;
  } catch {
    // Older CLIs print text; treat as unknown sign-in.
  }
  const method = text(status.authMethod, 40);
  const email = text(status.email) ?? text((status.account as Record<string, unknown> | undefined)?.email);
  const org = text(status.orgId) ?? text(status.orgName);
  const plan = text(status.subscriptionType, 40) ?? text(status.plan, 40);
  const configDirectory = text(status.configDirectory, 2000);
  const loggedIn = status.loggedIn === true;
  const auth: ClaudeAuth = {
    loggedIn,
    ...(method ? { method } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan: plan[0]!.toUpperCase() + plan.slice(1) } : {}),
    ...(configDirectory ? { configDirectory } : {}),
    supported: loggedIn && (status.apiProvider === undefined || status.apiProvider === "firstParty") && subscriptionMethods.has(method ?? ""),
    checkedAt: Date.now(),
    fingerprint: authFingerprint(profile.effectiveDir, { method, email, org, plan }),
  };
  if (configDirectory) {
    const reported = await realOrAncestor(configDirectory).catch(() => resolve(configDirectory));
    const expected = await realOrAncestor(profile.effectiveDir).catch(() => resolve(profile.effectiveDir));
    if (fold(reported) !== fold(expected)) {
      auth.supported = false;
      auth.error = "Claude Code reported a different config folder for this account.";
    }
  }
  if (!auth.error && loggedIn && !auth.supported)
    auth.error = "Unsupported sign-in: this account isn't signed in with a Claude subscription.";
  if (!auth.error && !loggedIn) auth.error = "Not signed in.";
  return auth;
}

/**
 * Transcript roots for another process (the Orvane MCP server), read-only.
 * That process runs with the env of whichever account launched it, so
 * Default's folders come from what the Orvane server recorded; an inherited
 * CLAUDE_CONFIG_DIR that belongs to an added account is never taken as Default.
 */
export function readProfileRoots(database: LocalDatabase, env: NodeJS.ProcessEnv = process.env) {
  const saved = database.appData(KEY) as Partial<Stored> | undefined;
  const list = saved?.version === 1 && Array.isArray(saved.profiles) ? saved.profiles : [];
  const added = list.filter((p) => p.id !== DEFAULT_PROFILE && p.configDir && profileIdPattern.test(p.id));
  const inherited = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : undefined;
  const inheritedIsAdded = !!inherited && added.some((p) => fold(resolve(p.configDir!)) === fold(inherited));
  const defaultDir = saved?.defaultSeen?.configDir ??
    (inherited && !inheritedIsAdded ? inherited : join(homedir(), ".claude"));
  const defaultProjects = (!inheritedIsAdded && env.ORVANE_CLAUDE_PROJECTS_DIR) ||
    saved?.defaultSeen?.projects || join(defaultDir, "projects");
  return [
    { id: DEFAULT_PROFILE, root: resolve(defaultProjects), configDir: defaultDir },
    ...added.map((p) => ({ id: p.id, root: join(p.configDir!, "projects"), configDir: p.configDir! })),
  ];
}
