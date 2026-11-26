const {
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} = require("node:fs");
const { join, relative, isAbsolute } = require("node:path");
const { createInterface } = require("node:readline");
const { spawn } = require("node:child_process");

let args = process.argv.slice(2);
// A Claude account's config folder, only when it lives inside this test
// workspace (an inherited real CLAUDE_CONFIG_DIR is never written to).
const accountDir = (() => {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return undefined;
  const rel = relative(__dirname, dir);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? dir : undefined;
})();
/** Per-account fixture files: the account folder, else the workspace. */
const home = accountDir ?? __dirname;
// `mcp add|get|remove` as Claude Code and Codex run them, for Agent Sessions →
// Settings. Claude keeps its servers in .claude.json; Codex answers `get --json`.
if (args[0] === "--mcp-provider") {
  const { readFileSync } = require("node:fs");
  const provider = args[1];
  args = args.slice(2);
  const file = join(provider === "claude" ? home : __dirname, provider === "claude" ? ".claude.json" : "codex-mcp.json");
  if (provider === "claude")
    appendFileSync(join(__dirname, "mcp-calls.jsonl"), JSON.stringify({ args, configDir: process.env.CLAUDE_CONFIG_DIR || "<unset>" }) + "\n");
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
const signedOut = existsSync(join(codex ? __dirname : home, "signed-out"));
const append = (file, record) =>
  appendFileSync(file, JSON.stringify(record) + "\n");
const fixture = (name, fallback) => {
  try {
    return require("node:fs").readFileSync(join(home, name), "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
};

if (args[0] === "auth" && args[1] === "login") {
  // Interactive sign-in stand-in: the real CLI opens the browser and writes
  // its own credentials. Here it only leaves a marker in the account folder.
  append(join(__dirname, "logins.jsonl"), { configDir: process.env.CLAUDE_CONFIG_DIR || "<unset>", args });
  writeFileSync(join(home, "login-marker"), "signed in by fixture");
  try {
    require("node:fs").rmSync(join(home, "signed-out"), { force: true });
  } catch {}
  process.stdout.write("Fixture sign-in complete.\r\n");
  setTimeout(() => process.exit(0), existsSync(join(__dirname, "slow-login")) ? 120_000 : 200);
} else if (args[1] === "status") {
  if (codex)
    console.error(signedOut ? "Not logged in" : "Logged in using ChatGPT");
  else {
    append(join(__dirname, "auth-status.jsonl"), { configDir: process.env.CLAUDE_CONFIG_DIR || "<unset>" });
    emit({
      loggedIn: !signedOut,
      authMethod: fixture("auth-method", "claude.ai"),
      apiProvider: "firstParty",
      email: fixture("auth-email", accountDir ? "work@fixture.example" : "default@fixture.example"),
      subscriptionType: "max",
      ...(accountDir ? { configDirectory: fixture("auth-config-dir", accountDir) } : {}),
    });
  }
  process.exitCode = signedOut ? 1 : 0;
} else if (args.includes("app-server")) {
  const folder = join(__dirname, "codex-sessions", "2026", "11", "21");
  const file = join(folder, "plan.jsonl");
  const record = (type, payload) => append(file, { type, payload, timestamp: new Date().toISOString() });
  const itemDone = (item) => emit({ method: "item/completed", params: { threadId: codexId, item } });
  createInterface({ input: process.stdin }).on("line", (line) => {
    const packet = JSON.parse(line);
    if (packet.method === "initialize") emit({ id: packet.id, result: {} });
    if (packet.method === "thread/start" || packet.method === "thread/resume") {
      append(join(__dirname, "codex-plan-thread.jsonl"), packet);
      mkdirSync(folder, { recursive: true });
      if (!existsSync(file)) record("session_meta", { id: codexId, cwd: process.cwd() });
      emit({ id: packet.id, result: { thread: { id: codexId }, model: packet.params.model || "test-codex" } });
    }
    if (packet.method === "turn/start") {
      append(join(__dirname, "codex-plan-turn.jsonl"), packet);
      emit({ id: packet.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
      record("event_msg", { type: "item_completed", item: { type: "UserMessage", content: packet.params.input } });
      const item = { id: "image-1", type: "imageView", path: join(__dirname, "project", "layout.png") };
      record("event_msg", { type: "item_completed", item: { ...item, type: "ImageView" } });
      itemDone(item);
      emit({ id: 17, method: "item/tool/requestUserInput", params: { questions: [
        { id: "layout", header: "Layout", question: "Which layout should I use?", options: [
          { label: "Above the dock", description: "Keep the dock in place." }, { label: "Full height", description: "Fill the right edge." },
        ] },
        { id: "marker", header: "Private marker", question: "What is the private marker?", isSecret: true, options: null },
      ] } });
    }
    if (packet.id === 17 && packet.result) {
      append(join(__dirname, "codex-plan-answers.jsonl"), packet.result);
      emit({ method: "serverRequest/resolved", params: { threadId: codexId, requestId: 17 } });
      const text = Object.keys(packet.result.answers).length ? "Plan answers received" : "Plan questions skipped";
      record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      itemDone({ id: "reply-1", type: "agentMessage", text });
      emit({ method: "turn/completed", params: { threadId: codexId, turn: { id: "turn-1", status: "completed" } } });
    }
  });
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
  // Default writes where it always did; an account writes in its own folder,
  // with the same session UUID (the collision case Orvane must keep apart).
  const file = accountDir
    ? join(accountDir, "projects", "test-project", claudeId + ".jsonl")
    : join(__dirname, "claude-projects", "test-project", claudeId + ".jsonl");
  mkdirSync(join(file, ".."), { recursive: true });
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
        configDir: process.env.CLAUDE_CONFIG_DIR || "<unset>",
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
      if (message === "Preview in full access" && args.includes("bypassPermissions")) {
        const result = "Preview ready";
        save("assistant", result);
        emit({ type: "assistant", message: { content: [{ type: "text", text: result }] } });
        emit({ type: "result", subtype: "success", session_id: claudeId });
        return;
      }
      if (message === "Ask me questions") {
        // Claude's AskUserQuestion arrives as a permission request.
        emit({
          type: "control_request",
          request_id: "question-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which zoom should focus mode use?",
                  header: "Focus zoom",
                  multiSelect: false,
                  options: [
                    { label: "UI 1x, page keeps zoom", description: "App at actual size.", preview: "PAGE 0.83x" },
                    { label: "Everything 1x", description: "Old behaviour." },
                  ],
                },
                {
                  question: "Where should Ctrl+arrows switch apps?",
                  header: "Ctrl+arrows",
                  multiSelect: true,
                  options: [
                    { label: "Canvas", description: "Outside text fields." },
                    { label: "Browser pages", description: "Needs a restart." },
                    { label: "Timeline", description: "Call rows." },
                  ],
                },
              ],
            },
          },
        });
        return;
      }
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
    if (packet.type === "control_response" && packet.response.request_id === "question-1") {
      const { behavior, updatedInput } = packet.response.response;
      const result =
        behavior === "allow"
          ? `Answers ${JSON.stringify(updatedInput.answers)} notes ${JSON.stringify(updatedInput.annotations ?? {})}`
          : "Questions skipped";
      save("assistant", result);
      emit({ type: "assistant", message: { content: [{ type: "text", text: result }] } });
      emit({ type: "result", subtype: "success", session_id: claudeId });
      return;
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
