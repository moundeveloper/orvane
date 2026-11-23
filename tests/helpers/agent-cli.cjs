const {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { spawn } = require("node:child_process");

let args = process.argv.slice(2);
// `mcp add|get|remove` as Claude Code and Codex run them, for Agent Sessions →
// Settings. Claude keeps its servers in .claude.json; Codex answers `get --json`.
if (args[0] === "--mcp-provider") {
  const { readFileSync } = require("node:fs");
  const provider = args[1];
  args = args.slice(2);
  const file = join(__dirname, provider === "claude" ? ".claude.json" : "codex-mcp.json");
  const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  const config = read();
  config.mcpServers ??= {};
  const [, action] = args;
  if (action === "add") {
    const split = args.indexOf("--");
    const options = args.slice(2, split);
    const name = options.find((value, index) => !value.startsWith("-") && !/^(-e|--env|-s)$/.test(options[index - 1] ?? ""));
    const env = {};
    options.forEach((value, index) => {
      if (/^(-e|--env)$/.test(options[index - 1] ?? "")) {
        const [key, ...rest] = value.split("=");
        env[key] = rest.join("=");
      }
    });
    const [command, ...commandArgs] = args.slice(split + 1);
    config.mcpServers[name] = { type: "stdio", command, args: commandArgs, env };
    writeFileSync(file, JSON.stringify(config));
  } else if (action === "remove") {
    delete config.mcpServers[args.filter((value) => !value.startsWith("-") && value !== "user").at(-1)];
    writeFileSync(file, JSON.stringify(config));
  } else if (action === "get") {
    const entry = config.mcpServers[args[2]];
    if (!entry) {
      console.error(`No MCP server named '${args[2]}' found.`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ name: args[2], transport: { type: "stdio", ...entry } }));
  }
  process.exit(0);
}
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const codexId = "22222222-2222-4222-8222-222222222222";
const claudeId = "11111111-1111-4111-8111-111111111111";
const codex = args.includes("exec") || args[0] === "login";
const signedOut = existsSync(join(__dirname, "signed-out"));
const append = (file, record) =>
  appendFileSync(file, JSON.stringify(record) + "\n");

if (args[1] === "status") {
  if (codex)
    console.error(signedOut ? "Not logged in" : "Logged in using ChatGPT");
  else
    emit({
      loggedIn: !signedOut,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
    });
  process.exitCode = signedOut ? 1 : 0;
} else if (codex) {
  let message = "";
  process.stdin
    .setEncoding("utf8")
    .on("data", (part) => {
      message += part;
    })
    .on("end", () => {
      const folder = join(__dirname, "codex-sessions", "2026", "11", "21");
      const file = join(folder, "rollout.jsonl");
      const wrap = (type, payload) =>
        append(file, { type, payload, timestamp: new Date().toISOString() });
      mkdirSync(folder, { recursive: true });
      if (!existsSync(file))
        wrap("session_meta", { id: codexId, cwd: process.cwd() });
      wrap("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Injected context" }],
      });
      wrap("event_msg", {
        type: "item_completed",
        item: {
          type: "UserMessage",
          content: [{ type: "text", text: message }],
        },
      });
      emit({ type: "thread.started", thread_id: codexId });
      const command = {
        id: "shell-1",
        type: "command_execution",
        command: "verify",
      };
      const mcp = {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "orvane",
        tool: "workspace_status",
      };
      emit({ type: "item.started", item: command });
      emit({
        type: "item.completed",
        item: { ...command, status: "completed" },
      });
      emit({ type: "item.started", item: mcp });
      const response = args.includes(codexId)
        ? "Codex resumed"
        : "Codex started";
      function finish() {
        emit({
          type: "item.completed",
          item: {
            ...mcp,
            status: "completed",
            result: { content: [{ text: "Private fixture output" }] },
          },
        });
        emit({
          type: "item.completed",
          item: {
            id: "summary-1",
            type: "reasoning",
            text: "Checked the workspace layout.",
          },
        });
        wrap("response_item", {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: response }],
        });
        wrap("event_msg", {
          type: "token_count",
          info: {
            model_context_window: 200_000,
            last_token_usage: { input_tokens: 95_000, cached_input_tokens: 60_000, output_tokens: 5_000 },
          },
          rate_limits: {
            limit_id: "codex",
            primary: { used_percent: 16.0, window_minutes: 300, resets_at: 1795439157 },
            secondary: { used_percent: 95.0, window_minutes: 10080, resets_at: 1795513771 },
          },
        });
        emit({
          type: "item.completed",
          item: { type: "agent_message", text: response },
        });
        emit({ type: "turn.completed" });
      }
      if (message.startsWith("Survey the launcher workflow")) {
        const deadline = Date.now() + 20_000;
        const gate = setInterval(() => {
          if (
            !existsSync(join(__dirname, "finish-launcher")) &&
            Date.now() < deadline
          )
            return;
          clearInterval(gate);
          finish();
        }, 50);
      } else setTimeout(finish, 120);
      append(join(__dirname, "inputs.jsonl"), {
        args,
        message,
        folder: process.cwd(),
      });
    });
} else {
  const lines = createInterface({ input: process.stdin });
  const file = join(
    __dirname,
    "claude-projects",
    "test-project",
    claudeId + ".jsonl",
  );
  const save = (type, content) =>
    append(file, {
      type,
      sessionId: claudeId,
      cwd: process.cwd(),
      timestamp: new Date().toISOString(),
      message: { content },
    });
  lines.on("line", (line) => {
    const packet = JSON.parse(line);
    if (packet.type === "user") {
      const message = packet.message.content;
      append(join(__dirname, "inputs.jsonl"), {
        args,
        message,
        folder: process.cwd(),
      });
      if (args.includes("--no-session-persistence")) {
        const input = JSON.parse(message);
        const text = input.previous ? "1. Import the record." : "Import the record before deploying.";
        emit({
          type: "assistant",
          message: { model: "claude-haiku-fixture", usage: { input_tokens: 10 }, content: [{ type: "text", text }] },
        });
        emit({ type: "result", subtype: "success", result: text });
        return;
      }
      if (message === "Wait for Stop") {
        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { stdio: "ignore", windowsHide: true },
        );
        writeFileSync(
          join(__dirname, "descendant.txt"),
          String(descendant.pid),
        );
        emit({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Wait" }] },
        });
        return;
      }
      save("user", message);
      emit({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        },
      });
      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Private fixture thought",
          },
        },
      });
      emit({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      });
      emit({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "mcp-fixture",
              name: "mcp__orvane__workspace_status",
            },
          ],
        },
      });
      emit({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "mcp-fixture", is_error: true },
          ],
        },
      });
      emit({
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "Preparing request" } },
      });
      emit({
        type: "control_request",
        request_id: "permission-1",
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { file_path: "fixture.txt" },
        },
      });
    }
    if (packet.type === "control_response") {
      const { behavior, updatedInput } = packet.response.response;
      const result =
        behavior === "allow" && updatedInput?.file_path === "fixture.txt"
          ? "Write approved"
          : "Write denied";
      save("assistant", result);
      emit({
        type: "assistant",
        message: { content: [{ type: "text", text: result }] },
      });
      emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: {
            five_hour: { utilization: 0.39, resetsAt: 1795440000, status: "allowed" },
            seven_day: { utilization: 0.44, resetsAt: 1795600800, status: "allowed" },
          },
        },
        session_id: claudeId,
      });
      emit({ type: "result", subtype: "success", session_id: claudeId });
    }
  });
}
