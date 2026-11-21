import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { agentNames, type AgentProvider } from "../src/agentSessions.ts";

const execute = promisify(execFile);
export type AgentCommand = { file: string; args: string[] };
type ModelOption = { value: string; label: string };

export function claudeModels(): Promise<ModelOption[]> {
  const command = findAgent("claude");
  return new Promise((resolve) => {
    const child = spawn(
      command.file,
      [
        ...command.args,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-session-persistence",
      ],
      {
        cwd: tmpdir(),
        env: agentEnvironment(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => {
      child.kill();
      finish([]);
    }, 8000);
    function finish(models: ModelOption[]) {
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      resolve(models);
    }
    child.once("error", () => finish([]));
    child.once("close", () => finish([]));
    child.stdin.on("error", () => {});
    lines.on("line", (line) => {
      let packet;
      try {
        packet = JSON.parse(line);
      } catch {
        return;
      }
      if (
        packet?.type !== "control_response" ||
        packet.response?.request_id !== "models"
      )
        return;
      const models: {
        value?: unknown;
        displayName?: unknown;
        description?: unknown;
      }[] = Array.isArray(packet.response?.response?.models)
        ? packet.response.response.models
        : [];
      finish(
        models.flatMap(({ value, displayName, description }) =>
          typeof value === "string" && typeof displayName === "string"
            ? [
                {
                  value: value === "default" ? "" : value,
                  label:
                    value === "default" && typeof description === "string"
                      ? `Default · ${description.split(" · ")[0]}`
                      : displayName,
                },
              ]
            : [],
        ),
      );
    });
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "models",
        request: { subtype: "initialize" },
      }) + "\n",
    );
  });
}

export function codexModels(): Promise<ModelOption[]> {
  const command = findAgent("codex");
  return new Promise((resolve) => {
    const child = spawn(command.file, [...command.args, "app-server"], {
      env: agentEnvironment(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    const timeout = setTimeout(() => finish([]), 4000);
    function finish(models: ModelOption[]) {
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      resolve(models);
    }
    function send(packet: unknown) {
      child.stdin.write(JSON.stringify(packet) + "\n");
    }
    child.once("error", () => finish([]));
    child.once("close", () => finish([]));
    child.stdin.on("error", () => finish([]));
    lines.on("line", (line) => {
      let packet;
      try {
        packet = JSON.parse(line);
      } catch {
        return;
      }
      if (packet?.id === 1 && packet.result) {
        send({ method: "initialized" });
        send({
          id: 2,
          method: "model/list",
          params: { includeHidden: false, limit: 100 },
        });
      } else if (packet?.id === 2) {
        const data: { model?: unknown; displayName?: unknown }[] =
          Array.isArray(packet.result?.data) ? packet.result.data : [];
        finish(
          data.flatMap((item) =>
            typeof item.model === "string" &&
            typeof item.displayName === "string"
              ? [{ value: item.model, label: item.displayName }]
              : [],
          ),
        );
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "orvane", version: "1.0.0" } },
    });
  });
}

export function agentEnvironment() {
  const env = { ...process.env };
  const removed = new Set([
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
  ]);
  for (const key of Object.keys(env))
    if (removed.has(key.toUpperCase())) delete env[key];
  return env;
}

function npmLauncher(
  provider: AgentProvider,
  folder: string,
): AgentCommand | undefined {
  const packagePath =
    provider === "codex"
      ? "@openai/codex/bin/codex.js"
      : "@anthropic-ai/claude-code/bin/claude.exe";
  const file = join(folder, "node_modules", packagePath);
  if (existsSync(file))
    return provider === "claude"
      ? { file, args: [] }
      : { file: process.execPath, args: [file] };
}

export function findAgent(provider: AgentProvider): AgentCommand {
  const setting =
    provider === "claude" ? "ORVANE_CLAUDE_PATH" : "ORVANE_CODEX_PATH";
  const override = process.env[setting];
  const windows = process.platform === "win32";
  const executable = windows ? `${provider}.exe` : provider;
  if (override) {
    if (isAbsolute(override) && existsSync(override)) {
      if (windows && /\.cmd$/i.test(override)) {
        const npm = npmLauncher(provider, dirname(override));
        if (npm) return npm;
      } else if (!windows || /\.exe$/i.test(override))
        return { file: override, args: [] };
    }
    throw Error(
      `${setting} must point to an installed CLI executable or its npm shim.`,
    );
  }
  const folders = (process.env.PATH || "").split(windows ? ";" : ":");
  if (windows) {
    if (process.env.APPDATA) folders.push(join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) {
      const winget = join(process.env.LOCALAPPDATA, "Microsoft", "WinGet");
      folders.push(join(winget, "Links"));
      const packages = join(winget, "Packages");
      if (provider === "claude" && existsSync(packages)) {
        for (const name of readdirSync(packages))
          if (name.startsWith("Anthropic.ClaudeCode_"))
            folders.push(join(packages, name));
      }
    }
  }
  folders.push(join(homedir(), ".local", "bin"));
  for (const raw of folders) {
    const folder = raw.replace(/^"|"$/g, "");
    if (!isAbsolute(folder)) continue;
    const file = join(folder, executable);
    if (existsSync(file)) return { file, args: [] };
    if (windows) {
      const npm = npmLauncher(provider, folder);
      if (npm) return npm;
    }
  }
  throw Error(
    `${agentNames[provider]} CLI was not found. Install it or set ${setting}.`,
  );
}

export const loginHint = (provider: AgentProvider) =>
  provider === "claude"
    ? "Run `claude auth login` and choose your Claude subscription."
    : "Run `codex login` and choose Sign in with ChatGPT.";

export async function verifyAgentLogin(
  provider: AgentProvider,
  command: AgentCommand,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  const args = provider === "claude" ? ["auth", "status"] : ["login", "status"];
  const output = await execute(command.file, [...command.args, ...args], {
    cwd,
    env,
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  }).catch(
    (
      error: NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      },
    ) => {
      if (error.code === "ENOENT" || error.code === "EACCES" || error.killed)
        throw Error(
          `Could not start ${agentNames[provider]} to check sign-in.`,
        );
      return { stdout: error.stdout || "", stderr: error.stderr || "" };
    },
  );
  if (provider === "codex") {
    if (/logged in using chatgpt/i.test(output.stdout + output.stderr)) return;
  } else {
    const status = JSON.parse(output.stdout || "{}");
    if (
      status.loggedIn &&
      status.apiProvider === "firstParty" &&
      ["claude.ai", "oauth"].includes(status.authMethod)
    )
      return;
  }
  throw Error(loginHint(provider));
}

export function agentArgs(
  provider: AgentProvider,
  sessionId?: string,
  model?: string,
) {
  if (provider === "claude")
    return [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool=stdio",
      "--permission-mode",
      "default",
      ...(model ? ["--model", model] : []),
      ...(sessionId ? ["--resume", sessionId] : []),
    ];
  return [
    "-a",
    "never",
    "-s",
    "workspace-write",
    "-c",
    'model_provider="openai"',
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    "sandbox_workspace_write.writable_roots=[]",
    "exec",
    "--json",
    "--skip-git-repo-check",
    ...(sessionId ? ["resume", sessionId] : []),
    ...(model ? ["--model", model] : []),
    "-",
  ];
}
