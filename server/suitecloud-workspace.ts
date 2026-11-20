import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { protectPrivateFolder, type CertificateService } from "./certificates.ts";

// One scratch SuiteCloud (SDF) project per NetSuite account, kept in Orvane's
// data folder, for agents to build and deploy objects and scripts quickly.
// The user can connect the account with a certificate. Orvane closes stdin
// for every CLI command.

export type SuiteCloudAuth = {
  authId: string;
  accountId: string;
  accountName: string;
  role: string;
  domain: string;
};

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// PowerShell can add progress records as CLIXML on stderr; drop them with colour codes.
const clean = (text: string) =>
  text.replace(/#< CLIXML\s*/g, "").replace(/<Objs [\s\S]*?<\/Objs>/g, "").replace(ANSI, "").replace(/\r/g, "");

export type CliResult = { code: number | null; output: string; timedOut: boolean };
type CertificateCli = { home: string; passkey: string };
type Settings = { authId?: string; certificateAuthId?: string };

/** Runs the suitecloud CLI without a console or input. */
export function runSuiteCloud(cwd: string, args: string[], timeoutMs = 600_000, certificate?: CertificateCli): Promise<CliResult> {
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.SUITECLOUD_CI;
    delete env.SUITECLOUD_CI_PASSKEY;
    delete env.SUITECLOUD_FALLBACK_PASSKEY;
    if (certificate) {
      if (args[0] !== "account:setup:ci") env.SUITECLOUD_CI = "1";
      env.SUITECLOUD_CI_PASSKEY = certificate.passkey;
      // The SDK stores its CI credentials under Java's user.home. Give it an
      // Orvane-owned directory so it can coexist with the user's CLI credentials.
      env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS ?? ""} "-Duser.home=${certificate.home}"`.trim();
    }
    // The Node CLI forwards the key path via a second shell when launching Java.
    const keyIndex = args[0] === "account:setup:ci" ? args.indexOf("--privatekeypath") + 1 : 0;
    const key = keyIndex ? args[keyIndex] : undefined;
    if (key && /[\s()&]/.test(key)) {
      args = [...args];
      args[keyIndex] = `"${key}"`;
    }
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const child =
      process.platform === "win32"
        ? spawn(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(`$ProgressPreference='SilentlyContinue'; & suitecloud ${args.map(literal).join(" ")}; exit $LASTEXITCODE`, "utf16le").toString("base64"),
            ],
            { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
          )
        : spawn("suitecloud", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0,
      timedOut = false;
    const keep = (chunk: Buffer) => {
      size += chunk.length;
      if (size < 4_000_000) chunks.push(chunk);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: null, output: String(error.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output: clean(Buffer.concat(chunks).toString("utf8")).trim(), timedOut });
    });
  });
}

/** Keeps the useful end of CLI output: errors and the last lines. */
export function summarizeCli(output: string, maxLines = 60) {
  const lines = output.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  if (lines.length <= maxLines) return lines.join("\n");
  const important = lines.filter((line) => /error|fail|warn|invalid|denied|not found/i.test(line)).slice(0, 20);
  return [...important, `… ${lines.length - maxLines} more lines …`, ...lines.slice(-(maxLines - important.length - 1))].join("\n");
}

export function parseAuthInfo(output: string): SuiteCloudAuth | null {
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "mi").exec(output)?.[1]?.trim() ?? "";
  const authId = field("Authentication ID");
  const accountId = field("Account ID");
  if (!authId || !accountId) return null;
  return { authId, accountId, accountName: field("Account Name"), role: field("Role"), domain: field("Domain") };
}
export const parseAuthIds = (output: string) =>
  [...new Set(clean(output).split("\n").map((line) => line.split("|")[0]!.trim()).filter((id) => /^[\w.@-]{1,100}$/.test(id)))];

/** Same normalization NetSuite uses in hosts: 4027610_SB1 ↔ 4027610-sb1. */
export const sameAccount = (a: string, b: string) => a.toLowerCase().replaceAll("-", "_") === b.toLowerCase().replaceAll("-", "_");
const accountFolder = (accountId: string) => accountId.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

export function createSuiteCloudWorkspace(dataDirectory: string, run = runSuiteCloud) {
  const root = join(dataDirectory, "suitecloud");
  let cache: { at: number; auths: SuiteCloudAuth[]; cli: string | null } | undefined;
  const projectPath = (accountId: string) => join(root, accountFolder(accountId));
  const settingsPath = (accountId: string) => join(root, `${accountFolder(accountId)}.json`);
  const connecting = new Set<string>();

  async function readSettings(accountId: string): Promise<Settings> {
    try {
      return JSON.parse(await readFile(settingsPath(accountId), "utf8"));
    } catch {
      return {};
    }
  }
  async function certificateCli(accountId: string, create = false): Promise<CertificateCli> {
    const home = resolve(root, ".credentials", accountFolder(accountId));
    const passkeyPath = join(home, "passkey");
    if (create) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await protectPrivateFolder(home);
      await writeFile(passkeyPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const passkey = await readFile(passkeyPath, "utf8").catch(() => "");
    if (!/^[a-f0-9]{64}$/.test(passkey))
      throw Error("The local SuiteCloud passkey is missing or invalid.");
    return { home, passkey };
  }
  /** CLI version and every auth ID with its account (cached a minute; refresh after a new login). */
  async function auths(refresh = false) {
    if (!refresh && cache && Date.now() - cache.at < 60_000) return cache;
    await mkdir(root, { recursive: true });
    const version = await run(root, ["--version"], 60_000);
    if (version.code !== 0) return (cache = { at: Date.now(), auths: [], cli: null });
    const list = await run(root, ["account:manageauth", "--list"], 60_000);
    const found: SuiteCloudAuth[] = [];
    for (const authId of parseAuthIds(list.output)) {
      const info = parseAuthInfo((await run(root, ["account:manageauth", "--info", authId], 60_000)).output);
      if (info) found.push(info);
    }
    return (cache = { at: Date.now(), auths: found, cli: version.output.split("\n").pop()?.trim() || "unknown" });
  }
  async function srcFolder(accountId: string) {
    const config = await readFile(join(projectPath(accountId), "suitecloud.config.js"), "utf8");
    const folder = /defaultProjectFolder\s*:\s*['"]([^'"]+)['"]/.exec(config)?.[1] ?? "src";
    const full = resolve(projectPath(accountId), folder);
    if (!full.startsWith(projectPath(accountId) + sep)) throw Error("defaultProjectFolder must stay inside the project.");
    return full;
  }
  const exists = (path: string) => stat(path).then(() => true, () => false);

  /** Whether the workspace can be used for an account, and why not. */
  async function status(accountId: string, refresh = false) {
    const { cli, auths: all } = await auths(refresh);
    const settings = await readSettings(accountId);
    const authIds = all.filter((auth) => sameAccount(auth.accountId, accountId)).map((auth) => auth.authId);
    if (settings.certificateAuthId && !authIds.includes(settings.certificateAuthId)) authIds.unshift(settings.certificateAuthId);
    const authId = settings.authId && authIds.includes(settings.authId) ? settings.authId : authIds[0] ?? null;
    const path = projectPath(accountId);
    return {
      accountId,
      available: Boolean(cli && authId),
      cli,
      authIds,
      authId,
      reason: !cli
        ? "The SuiteCloud CLI is not installed (npm install -g @oracle/suitecloud-cli)."
        : !authId
          ? "Connect this account with a certificate in NetSuite → SuiteCloud."
          : null,
      projectPath: path,
      created: await exists(join(path, "suitecloud.config.js")),
    };
  }
  async function chooseAuth(accountId: string, authId: string) {
    const current = await status(accountId);
    if (!current.authIds.includes(authId)) throw Error(`${authId} is not an authentication ID for account ${accountId}.`);
    await mkdir(root, { recursive: true });
    const settings = await readSettings(accountId);
    if (current.created) await writeFile(join(current.projectPath, "project.json"), JSON.stringify({ defaultAuthId: authId }, null, 2) + "\n");
    await writeFile(settingsPath(accountId), JSON.stringify({ ...settings, authId }, null, 2));
    return status(accountId);
  }
  async function ensureProject(accountId: string, current: Awaited<ReturnType<typeof status>>) {
    const path = current.projectPath;
    if (!current.created) {
      const name = accountFolder(accountId);
      const created = await run(root, ["project:create", "--type", "ACCOUNTCUSTOMIZATION", "--projectname", name], 300_000);
      if (created.code !== 0 || !(await exists(join(path, "suitecloud.config.js"))))
        throw Error(`Could not create the SuiteCloud project: ${summarizeCli(created.output, 20)}`);
    }
    // The data folder can sit inside a "type": "module" package (Orvane's own),
    // which makes Node read suitecloud.config.js as ESM and the CLI fail.
    if (!(await exists(join(path, "package.json"))))
      await writeFile(join(path, "package.json"), JSON.stringify({ private: true, type: "commonjs" }, null, 2) + "\n");
  }
  /** Creates the account's project on first use and points it at the chosen auth ID. */
  async function ensure(accountId: string) {
    const current = await status(accountId);
    if (!current.available) throw Object.assign(Error(current.reason ?? "SuiteCloud is not available."), { code: "SUITECLOUD_UNAVAILABLE" });
    await ensureProject(accountId, current);
    await writeFile(join(current.projectPath, "project.json"), JSON.stringify({ defaultAuthId: current.authId }, null, 2) + "\n");
    return { ...current, created: true };
  }
  async function connectCertificate(accountId: string, pairId: string, certificateId: string, certificates: Pick<CertificateService, "suiteCloudKeyPath">) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(certificateId)) throw Error("Enter the certificate ID from NetSuite.");
    const folder = accountFolder(accountId);
    if (connecting.has(folder)) throw Error("A certificate connection is already in progress for this account.");
    connecting.add(folder);
    try {
      const current = await status(accountId);
      if (!current.cli) throw Error(current.reason ?? "SuiteCloud CLI is unavailable.");
      const keyPath = await certificates.suiteCloudKeyPath(pairId, accountId);
      if (/[\r\n"'`$%!?*<>|^;]/.test(keyPath)) throw Error("The certificate storage path contains characters the SuiteCloud CLI cannot safely use.");
      await ensureProject(accountId, current);
      const credentials = await certificateCli(accountId, true);
      const previous = await readSettings(accountId);
      const base = `orvane-${folder}`.slice(0, 31);
      // A renewal uses a new alias so a failed setup leaves the prior one usable.
      const authId = previous.certificateAuthId ? `${base}-${randomBytes(4).toString("hex")}` : base;
      const args = ["account:setup:ci", "--account", accountId.toUpperCase().replaceAll("-", "_"), "--authid", authId, "--certificateid", certificateId, "--privatekeypath", keyPath];
      const result = await run(current.projectPath, args, 120_000, credentials);
      if (result.timedOut) throw Error("SuiteCloud certificate setup timed out.");
      if (result.code !== 0) {
        const detail = summarizeCli(result.output, 15).replaceAll(keyPath, "[private key path]").replaceAll(credentials.passkey, "[passkey]");
        throw Error(detail || "SuiteCloud could not connect with this certificate.");
      }
      await writeFile(join(current.projectPath, "project.json"), JSON.stringify({ defaultAuthId: authId }, null, 2) + "\n");
      await writeFile(settingsPath(accountId), JSON.stringify({ authId, certificateAuthId: authId }, null, 2));
      return status(accountId);
    } finally {
      connecting.delete(folder);
    }
  }
  /** Resolves a project-relative path (inside the src folder) safely. */
  async function inside(accountId: string, path: string) {
    const base = await srcFolder(accountId);
    const full = resolve(base, path.replace(/^[/\\]+/, ""));
    if (full !== base && !full.startsWith(base + sep)) throw Error(`Path ${path} is outside the project.`);
    return { base, full, rel: relative(base, full).split(sep).join("/") };
  }
  async function tree(accountId: string, under = "", limit = 2000) {
    const { base, full } = await inside(accountId, under);
    const files: { path: string; size: number }[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (files.length >= limit) return;
        const item = join(dir, entry.name);
        if (entry.isDirectory()) await walk(item);
        else files.push({ path: relative(base, item).split(sep).join("/"), size: (await stat(item)).size });
      }
    };
    await walk(full);
    return { files, truncated: files.length >= limit };
  }
  async function readFiles(accountId: string, paths: string[], maxChars = 200_000) {
    const out: { path: string; content?: string; error?: string; truncated?: boolean }[] = [];
    let budget = maxChars;
    for (const path of paths) {
      const { full, rel } = await inside(accountId, path);
      try {
        const text = await readFile(full, "utf8");
        const content = text.slice(0, Math.max(0, budget));
        budget -= content.length;
        out.push({ path: rel, content, ...(content.length < text.length ? { truncated: true } : {}) });
      } catch (error) {
        out.push({ path: rel, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return out;
  }
  /** Bulk writes and find/replace edits in one call; every edit must match. */
  async function writeFiles(
    accountId: string,
    files: { path: string; content: string }[] = [],
    edits: { path: string; find: string; replace: string; all?: boolean }[] = [],
    remove: string[] = [],
  ) {
    const changed: string[] = [];
    for (const file of files) {
      const { full, rel } = await inside(accountId, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content, "utf8");
      changed.push(rel);
    }
    for (const edit of edits) {
      const { full, rel } = await inside(accountId, edit.path);
      const text = await readFile(full, "utf8");
      const count = text.split(edit.find).length - 1;
      if (!count) throw Error(`Edit not applied: "${edit.find.slice(0, 80)}" not found in ${rel}.`);
      if (count > 1 && !edit.all) throw Error(`Edit not applied: "${edit.find.slice(0, 80)}" matches ${count} times in ${rel}; pass all: true or a longer find.`);
      await writeFile(full, edit.all ? text.split(edit.find).join(edit.replace) : text.replace(edit.find, () => edit.replace), "utf8");
      changed.push(rel);
    }
    const removed: string[] = [];
    for (const path of remove) {
      const { full, rel, base } = await inside(accountId, path);
      if (full === base) throw Error("Refusing to delete the whole project folder.");
      await rm(full, { recursive: true, force: true });
      removed.push(rel);
    }
    return { changed: [...new Set(changed)], removed };
  }
  /** Runs one allowlisted, non-interactive CLI command in the account's project. */
  async function cli(accountId: string, command: "deploy" | "validate" | "add-dependencies" | "import-objects" | "import-files" | "list-objects", options: { scriptIds?: string[]; paths?: string[]; type?: string; dryRun?: boolean } = {}) {
    const ready = await ensure(accountId);
    // Commands use project.json defaultAuthId (set by ensure); they take no --authid flag.
    let args: string[];
    if (command === "deploy") args = ["project:deploy", ...(options.dryRun ? ["--dryrun"] : [])];
    else if (command === "validate") args = ["project:validate", "--server"];
    else if (command === "add-dependencies") args = ["project:adddependencies"];
    else if (command === "import-objects") {
      if (!options.scriptIds?.length || options.scriptIds.some((id) => !/^[a-z0-9_]{1,100}$/i.test(id))) throw Error("Give scriptIds (letters, digits, underscore).");
      args = ["object:import", "--type", "ALL", "--scriptid", ...options.scriptIds, "--destinationfolder", "/Objects"];
    } else if (command === "import-files") {
      if (!options.paths?.length || options.paths.some((path) => !/^\/SuiteScripts\/[^\0]+$/.test(path))) throw Error("Give File Cabinet paths under /SuiteScripts/.");
      args = ["file:import", "--paths", ...options.paths];
    } else {
      args = ["object:list", ...(options.type ? ["--type", options.type] : [])];
    }
    const settings = await readSettings(accountId);
    const certificate = ready.authId === settings.certificateAuthId ? await certificateCli(accountId) : undefined;
    const result = await run(ready.projectPath, args, 900_000, certificate);
    const expired = result.code !== 0 && /no longer valid|browser-based authentication|certificate.*(?:expired|revoked)|invalid_grant/i.test(result.output);
    return {
      command: `suitecloud ${args.join(" ")}`,
      ok: result.code === 0 && !result.timedOut,
      exitCode: result.code,
      timedOut: result.timedOut,
      output: summarizeCli(result.output),
      ...(expired
        ? { authExpired: ready.authId, nextStep: "Open NetSuite → SuiteCloud → Connect with certificate, or select another authentication ID." }
        : {}),
    };
  }
  return { root, projectPath, status, chooseAuth, connectCertificate, ensure, tree, readFiles, writeFiles, cli, auths };
}
