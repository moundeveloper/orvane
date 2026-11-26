// Agent Sessions → Settings → Orvane MCP: installs, reads, tests and removes
// the Orvane MCP server in the Claude Code and Codex CLIs, through each CLI's
// own `mcp` commands (nothing here edits their config files directly).
// Nothing is written until the owner presses Install or Remove.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentProvider } from "../src/agentSessions.ts";
import { agentEnvironment, findAgent, type AgentCommand } from "./agent-cli.ts";

const execute = promisify(execFile);
const NAME = "orvane";

export type McpServer = { command: string; args: string[]; env: Record<string, string> };
export type McpRow = {
  provider: AgentProvider;
  /** false: the CLI itself was not found, so nothing can be installed. */
  cli: boolean;
  installed: boolean;
  /** Where the entry lives, as the CLI stores it. */
  where: string;
  /** The entry Install writes, shown before anything is written. */
  preview: string;
  server?: McpServer;
};

export type McpSetup = {
  /** The Claude config file that holds user-scope MCP servers. */
  claudeFile: string;
  cli(provider: AgentProvider): AgentCommand;
  /** The Orvane server command Install registers. */
  server: McpServer;
  /** The child env for the CLI's `mcp` commands: a Claude account's own
   * env, so `claude mcp add -s user` writes only that account's file. */
  env?: Readonly<NodeJS.ProcessEnv>;
  /** How the Claude entry's location reads in Settings. */
  claudeWhere?: string;
};

export function mcpSetup(dataDir: string): McpSetup {
  return {
    claudeFile: join(process.env.CLAUDE_CONFIG_DIR || homedir(), ".claude.json"),
    cli: findAgent,
    server: {
      command: process.execPath,
      args: [fileURLToPath(new URL("./launch.mjs", import.meta.url))],
      env: { ORVANE_DATA_DIR: dataDir },
    },
  };
}

async function run(setup: McpSetup, provider: AgentProvider, args: string[]) {
  const command = setup.cli(provider);
  const { stdout } = await execute(command.file, [...command.args, ...args], {
    env: { ...(setup.env ?? agentEnvironment()) },
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 256 * 1024,
  });
  return stdout;
}

const quote = (value: string) => `'${value}'`;
function preview(provider: AgentProvider, server: McpServer) {
  const env = Object.entries(server.env);
  if (provider === "codex")
    return [
      `[mcp_servers.${NAME}]`,
      `command = ${quote(server.command)}`,
      `args = [${server.args.map(quote).join(", ")}]`,
      ...(env.length ? ["", `[mcp_servers.${NAME}.env]`, ...env.map(([k, v]) => `${k} = ${quote(v)}`)] : []),
    ].join("\n");
  return JSON.stringify({ mcpServers: { [NAME]: { type: "stdio", ...server } } }, null, 2);
}

function hasCli(setup: McpSetup, provider: AgentProvider) {
  try {
    setup.cli(provider);
    return true;
  } catch {
    return false;
  }
}

async function configured(setup: McpSetup, provider: AgentProvider): Promise<McpServer | undefined> {
  if (provider === "claude") {
    const config = JSON.parse(await readFile(setup.claudeFile, "utf8").catch(() => "{}"));
    const entry = config?.mcpServers?.[NAME];
    return entry && typeof entry.command === "string"
      ? { command: entry.command, args: Array.isArray(entry.args) ? entry.args : [], env: entry.env ?? {} }
      : undefined;
  }
  const output = await run(setup, "codex", ["mcp", "get", NAME, "--json"]).catch(() => "");
  try {
    const transport = JSON.parse(output)?.transport;
    return transport?.command
      ? { command: transport.command, args: transport.args ?? [], env: transport.env ?? {} }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function mcpStatus(
  setup: McpSetup,
  providers: readonly AgentProvider[] = ["claude", "codex"],
): Promise<McpRow[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const cli = hasCli(setup, provider);
      const server = cli ? await configured(setup, provider) : undefined;
      return {
        provider,
        cli,
        installed: !!server,
        where: provider === "claude"
          ? `${setup.claudeWhere ?? "~/.claude.json"} · mcpServers.${NAME} · user scope`
          : `~/.codex/config.toml · [mcp_servers.${NAME}]`,
        preview: preview(provider, setup.server),
        ...(server ? { server } : {}),
      };
    }),
  );
}

export async function mcpInstall(setup: McpSetup, provider: AgentProvider) {
  const { command, args, env } = setup.server;
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  await run(
    setup,
    provider,
    provider === "claude"
      ? ["mcp", "add", "-s", "user", NAME, ...vars.flatMap((v) => ["-e", v]), "--", command, ...args]
      : ["mcp", "add", NAME, ...vars.flatMap((v) => ["--env", v]), "--", command, ...args],
  );
}

export async function mcpRemove(setup: McpSetup, provider: AgentProvider) {
  await run(setup, provider, provider === "claude" ? ["mcp", "remove", "-s", "user", NAME] : ["mcp", "remove", NAME]);
}

/** Starts the configured server as the CLI would and counts its tools. */
export async function mcpTest(setup: McpSetup, provider: AgentProvider) {
  const server = await configured(setup, provider);
  if (!server) throw Error("The Orvane MCP is not set up for this CLI.");
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: {
      ...Object.fromEntries(
        Object.entries(setup.env ?? agentEnvironment()).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      ...server.env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "orvane-settings-test", version: "1.0.0" });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(Error("The Orvane MCP did not answer within 20 seconds.")), 20_000);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { tools: tools.length };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
