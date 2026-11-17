// Real terminals for the Terminal app: each pane is a pseudo-console
// (node-pty; ConPTY on Windows) streamed live over a WebSocket at
// /__orvane/terminal. Sessions outlive the page, so reloading Orvane keeps
// running shells and replays their recent output; a session nobody has
// watched for SESSION_IDLE_MS ends. Same-origin loopback requests only.
//
// Profiles are the shells found on this machine: Command Prompt, Windows
// PowerShell, PowerShell 7, Git Bash, WSL distributions, Visual Studio
// developer shells and the custom profiles in Windows Terminal's settings.
import type { Plugin } from "vite";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import * as pty from "node-pty";

export interface TerminalProfile {
  id: string;
  name: string;
  /** What kind of shell, for its icon. */
  kind: "cmd" | "powershell" | "bash" | "wsl" | "other";
  file: string;
  /** An array, or (Windows) a raw command-line string. */
  args: string[] | string;
  cwd?: string;
  source: "detected" | "windows-terminal" | "visual-studio";
}

const PATH = "/__orvane/terminal";
const SESSION_IDLE_MS = 15 * 60 * 1000;
const SCROLLBACK_CHARS = 1_000_000;
const MAX_INPUT = 1_000_000;

// Leave line editing with PSReadLine so predictions and completion only appear
// while the shell is reading a command. Older versions still offer native Tab.
const powerShellStartup = `
& {
  $options = Get-Command Set-PSReadLineOption -ErrorAction Ignore
  if (!$options) { return }
  try {
    if (!(Get-PSReadLineKeyHandler | Where-Object Key -eq 'Ctrl+Spacebar')) {
      Set-PSReadLineKeyHandler -Chord Ctrl+Spacebar -Function MenuComplete -ErrorAction Stop
    }
    if ($options.Parameters.ContainsKey('PredictionViewStyle')) {
      if ((Get-PSReadLineOption).PredictionSource -eq 'None') {
        Set-PSReadLineOption -PredictionSource History -ErrorAction Stop
      }
      Set-PSReadLineOption -PredictionViewStyle ListView -ErrorAction Stop
      $esc = [char]27
      Set-PSReadLineOption -Colors @{
        ListPredictionSelected = "$esc[38;2;34;55;68;48;2;220;232;239m"
      } -ErrorAction Stop
    }
  } catch {
    # Some consoles or PSReadLine versions do not support predictions.
  }
}
`;

function shellArgs(profile: TerminalProfile): TerminalProfile["args"] {
  if ((profile.id === "pwsh" || profile.id === "powershell") && Array.isArray(profile.args)) {
    const startup = Buffer.from(powerShellStartup, "utf16le").toString("base64");
    return [...profile.args, "-NoExit", "-EncodedCommand", startup];
  }
  return profile.args;
}

function local(req: IncomingMessage) {
  const host = req.headers.host || "";
  return (
    /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) &&
    // A WebSocket always sends its page's origin: it must be Orvane's own.
    req.headers.origin === `http://${host}` &&
    req.headers["sec-fetch-site"] !== "cross-site" &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
  );
}

// ---- Profiles ----
const run = (file: string, args: string[], encoding: BufferEncoding = "utf8") =>
  new Promise<string>((resolve) =>
    execFile(file, args, { timeout: 4000, windowsHide: true, encoding: "buffer" }, (error, stdout) =>
      resolve(error ? "" : stdout.toString(encoding)),
    ),
  );
const expand = (value: string) =>
  value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? whole);
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
/** Windows Terminal settings are JSON with comments and trailing commas. */
function parseJsonc(text: string) {
  let out = "",
    quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') quote = false;
    } else if (c === '"') {
      quote = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
/** "C:\\x y\\a.exe" -b c  →  file and the rest of the command line. */
function splitCommandLine(commandline: string) {
  const line = expand(commandline.trim());
  const match = line.startsWith('"') ? /^"([^"]+)"\s*(.*)$/.exec(line) : /^(\S+)\s*(.*)$/.exec(line);
  return match ? { file: match[1]!, args: match[2] ?? "" } : null;
}
const kindOf = (file: string): TerminalProfile["kind"] => {
  const name = file.toLowerCase().replace(/^.*[\\/]/, "");
  if (name === "cmd.exe" || name === "cmd") return "cmd";
  if (name.startsWith("pwsh") || name.startsWith("powershell")) return "powershell";
  if (name === "wsl.exe" || name === "wsl") return "wsl";
  if (name.includes("bash") || name.includes("zsh") || name.endsWith("sh")) return "bash";
  return "other";
};

async function windowsProfiles() {
  const list: TerminalProfile[] = [];
  // The same shell found twice (e.g. detected and in Windows Terminal) is
  // listed once: paths compare case-insensitively, ignoring -NoLogo.
  const keyOf = (p: TerminalProfile) =>
    `${p.file.toLowerCase()} ${(Array.isArray(p.args) ? p.args.join(" ") : p.args).replace(/(^|\s)-nologo\b/gi, "")}`
      .replace(/\s+/g, " ")
      .trim();
  const add = (profile: TerminalProfile) => {
    if (!list.some((p) => keyOf(p) === keyOf(profile))) list.push(profile);
  };
  const system = process.env.SystemRoot || "C:\\Windows";
  const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter(
    (p): p is string => !!p,
  );
  const localApp = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");

  // PowerShell 7 (newest first), from Program Files or the Store.
  const pwsh: string[] = [];
  for (const base of programFiles) {
    const dir = join(base, "PowerShell");
    try {
      for (const version of readdirSync(dir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
        if (isFile(join(dir, version, "pwsh.exe"))) pwsh.push(join(dir, version, "pwsh.exe"));
    } catch {
      // Not installed there.
    }
  }
  if (isFile(join(localApp, "Microsoft", "WindowsApps", "pwsh.exe")))
    pwsh.push(join(localApp, "Microsoft", "WindowsApps", "pwsh.exe"));
  if (pwsh[0])
    add({ id: "pwsh", name: "PowerShell", kind: "powershell", file: pwsh[0], args: ["-NoLogo"], source: "detected" });
  const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (isFile(powershell))
    add({ id: "powershell", name: "Windows PowerShell", kind: "powershell", file: powershell, args: ["-NoLogo"], source: "detected" });
  const cmd = process.env.ComSpec || join(system, "System32", "cmd.exe");
  if (isFile(cmd)) add({ id: "cmd", name: "Command Prompt", kind: "cmd", file: cmd, args: [], source: "detected" });

  // Git Bash.
  for (const base of [...programFiles, join(localApp, "Programs")]) {
    const bash = join(base, "Git", "bin", "bash.exe");
    if (isFile(bash)) {
      add({ id: "git-bash", name: "Git Bash", kind: "bash", file: bash, args: ["--login", "-i"], source: "detected" });
      break;
    }
  }

  // WSL distributions (wsl.exe lists them in UTF-16).
  const wsl = join(system, "System32", "wsl.exe");
  if (isFile(wsl)) {
    const names = (await run(wsl, ["-l", "-q"], "utf16le"))
      .split(/\r?\n/)
      .map((n) => n.replace(/\0/g, "").trim())
      .filter((n) => n && !/\s/.test(n));
    for (const name of names)
      add({ id: `wsl:${name}`, name: `${name} (WSL)`, kind: "wsl", file: wsl, args: ["-d", name], source: "detected" });
  }

  // Visual Studio developer shells.
  const vswhere = join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (isFile(vswhere)) {
    try {
      const installs = JSON.parse((await run(vswhere, ["-all", "-prerelease", "-format", "json", "-utf8"])) || "[]") as {
        instanceId: string;
        installationPath: string;
        displayName?: string;
        catalog?: { productLineVersion?: string };
      }[];
      for (const vs of installs) {
        const label = vs.catalog?.productLineVersion ? `VS ${vs.catalog.productLineVersion}` : vs.displayName || "Visual Studio";
        const devShell = join(vs.installationPath, "Common7", "Tools", "Microsoft.VisualStudio.DevShell.dll");
        if (isFile(devShell) && isFile(powershell))
          add({
            id: `vs-ps:${vs.instanceId}`,
            name: `Developer PowerShell for ${label}`,
            kind: "powershell",
            file: powershell,
            args: ["-NoLogo", "-NoExit", "-Command", `&{Import-Module '${devShell}'; Enter-VsDevShell ${vs.instanceId} -SkipAutomaticLocation}`],
            source: "visual-studio",
          });
        const devCmd = join(vs.installationPath, "Common7", "Tools", "VsDevCmd.bat");
        if (isFile(devCmd) && isFile(cmd))
          add({
            id: `vs-cmd:${vs.instanceId}`,
            name: `Developer Command Prompt for ${label}`,
            kind: "cmd",
            file: cmd,
            args: `/k "${devCmd}"`,
            source: "visual-studio",
          });
      }
    } catch {
      // No usable answer from vswhere.
    }
  }

  // Custom profiles from Windows Terminal (store, preview or unpackaged).
  for (const settings of [
    join(localApp, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(localApp, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(localApp, "Microsoft", "Windows Terminal", "settings.json"),
  ]) {
    if (!isFile(settings)) continue;
    try {
      const data = parseJsonc(readFileSync(settings, "utf8"));
      const profiles = Array.isArray(data?.profiles) ? data.profiles : data?.profiles?.list;
      for (const p of Array.isArray(profiles) ? profiles : []) {
        if (!p || p.hidden || typeof p.commandline !== "string" || typeof p.name !== "string") continue;
        const parts = splitCommandLine(p.commandline);
        if (!parts) continue;
        add({
          id: `wt:${typeof p.guid === "string" ? p.guid : p.name}`,
          name: p.name,
          kind: kindOf(parts.file),
          file: parts.file,
          args: parts.args,
          cwd: typeof p.startingDirectory === "string" ? expand(p.startingDirectory) : undefined,
          source: "windows-terminal",
        });
      }
    } catch {
      // Unreadable settings are skipped.
    }
  }
  return list;
}
function unixProfiles() {
  const list: TerminalProfile[] = [];
  const shells = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/usr/bin/fish", "/bin/sh"].filter(
    (s, i, all): s is string => !!s && all.indexOf(s) === i && existsSync(s),
  );
  for (const file of shells)
    list.push({ id: file, name: file.replace(/^.*\//, ""), kind: kindOf(file), file, args: ["-l"], source: "detected" });
  return list;
}
let cached: { at: number; profiles: TerminalProfile[] } | undefined;
export async function terminalProfiles() {
  if (cached && Date.now() - cached.at < 30_000) return cached.profiles;
  const profiles = process.platform === "win32" ? await windowsProfiles() : unixProfiles();
  cached = { at: Date.now(), profiles };
  return profiles;
}

// ---- Sessions ----
interface Session {
  id: string;
  proc: pty.IPty;
  output: string;
  clients: Set<WebSocket>;
  idle?: ReturnType<typeof setTimeout>;
}
const sessions = new Map<string, Session>();
const send = (ws: WebSocket, message: unknown) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
};
function end(session: Session) {
  clearTimeout(session.idle);
  sessions.delete(session.id);
  try {
    session.proc.kill();
  } catch {
    // Already gone.
  }
}
function release(session: Session, ws: WebSocket) {
  session.clients.delete(ws);
  if (!session.clients.size) {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => end(session), SESSION_IDLE_MS);
  }
}
const validId = (id: unknown): id is string => typeof id === "string" && /^[\w-]{6,64}$/.test(id);
const size = (n: unknown, max: number) => Math.max(2, Math.min(max, Math.floor(Number(n)) || 0));
async function open(ws: WebSocket, message: Record<string, unknown>) {
  const id = message.id;
  if (!validId(id)) return;
  const cols = size(message.cols, 1000),
    rows = size(message.rows, 500);
  const existing = sessions.get(id);
  if (existing) {
    clearTimeout(existing.idle);
    existing.clients.add(ws);
    try {
      existing.proc.resize(cols, rows);
    } catch {
      // Exited between messages.
    }
    return send(ws, { t: "attached", id, replay: existing.output });
  }
  const profiles = await terminalProfiles();
  const profile = profiles.find((p) => p.id === message.profile) ?? profiles[0];
  if (!profile) return send(ws, { t: "error", id, message: "No shell was found on this computer." });
  let cwd = typeof message.cwd === "string" && message.cwd ? message.cwd : profile.cwd || homedir();
  try {
    if (!statSync(cwd).isDirectory()) cwd = homedir();
  } catch {
    cwd = homedir();
  }
  let proc: pty.IPty;
  try {
    proc = pty.spawn(profile.file, shellArgs(profile), {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Orvane" } as Record<string, string>,
    });
  } catch (error) {
    return send(ws, { t: "error", id, message: `Could not start ${profile.name}: ${error instanceof Error ? error.message : error}` });
  }
  const session: Session = { id, proc, output: "", clients: new Set([ws]) };
  sessions.set(id, session);
  proc.onData((data) => {
    session.output += data;
    if (session.output.length > SCROLLBACK_CHARS * 1.2) session.output = session.output.slice(-SCROLLBACK_CHARS);
    for (const client of session.clients) send(client, { t: "o", id, d: data });
  });
  proc.onExit(({ exitCode }) => {
    if (sessions.get(id) !== session) return;
    clearTimeout(session.idle);
    sessions.delete(id);
    for (const client of session.clients) send(client, { t: "exit", id, code: exitCode });
  });
  send(ws, { t: "started", id, profile: profile.id, name: profile.name });
}
function handle(ws: WebSocket, raw: string) {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const session = validId(message.id) ? sessions.get(message.id) : undefined;
  switch (message.t) {
    case "open":
      return void open(ws, message);
    case "in":
      if (session && typeof message.d === "string" && message.d.length <= MAX_INPUT) session.proc.write(message.d);
      return;
    case "resize":
      try {
        session?.proc.resize(size(message.cols, 1000), size(message.rows, 500));
      } catch {
        // Exited.
      }
      return;
    case "detach":
      if (session) release(session, ws);
      return;
    case "kill":
      if (session) end(session);
      return;
  }
}

function attach(http: Server | null | undefined) {
  if (!http) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * MAX_INPUT });
  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((req.url || "").split("?")[0] !== PATH) return;
    if (!local(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (data) => handle(ws, data.toString()));
      ws.on("close", () => {
        for (const session of sessions.values()) if (session.clients.has(ws)) release(session, ws);
      });
    });
  });
}
const profilesRoute = async (req: IncomingMessage, res: import("node:http").ServerResponse, next: () => void) => {
  if ((req.url || "").split("?")[0] !== `${PATH}/profiles`) return next();
  const host = req.headers.host || "";
  if (
    !/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ||
    (req.headers.origin && req.headers.origin !== `http://${host}`) ||
    req.headers["sec-fetch-site"] === "cross-site" ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
  ) {
    res.statusCode = 403;
    return res.end();
  }
  const profiles = await terminalProfiles();
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  // The shell paths stay on the server; the page needs names and kinds.
  res.end(JSON.stringify({ profiles: profiles.map(({ id, name, kind, source }) => ({ id, name, kind, source })) }));
};
export function terminalApi(): Plugin {
  return {
    name: "orvane-terminal",
    configureServer(server) {
      server.middlewares.use(profilesRoute);
      attach(server.httpServer as Server | null);
    },
    configurePreviewServer(server) {
      server.middlewares.use(profilesRoute);
      attach(server.httpServer as Server | null);
    },
  };
}
// Shells end with the server (Vite handles the signals and exits).
process.once("exit", () => {
  for (const session of sessions.values()) end(session);
});
