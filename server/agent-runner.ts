import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  agentBusy,
  summarizeAgentRun,
  type AgentActivity,
  type AgentProvider,
  type AgentRun,
} from "../src/agentSessions.ts";
import {
  agentArgs,
  agentEnvironment,
  findAgent,
  loginHint,
  verifyAgentLogin,
} from "./agent-cli.ts";
import { stepInput, stepOutput } from "./step-details.ts";

type Target = {
  provider: AgentProvider;
  folder: string;
  key?: string;
  sessionId?: string;
  model?: string;
};
type Entry = {
  view: AgentRun;
  lock: string;
  child?: ChildProcessWithoutNullStreams;
  clients: Set<ServerResponse>;
  inputs: Map<string, unknown>;
  decisions: { tool: string; allowed: boolean }[];
  timer?: ReturnType<typeof setTimeout>;
  updates?: ReturnType<typeof setTimeout>;
  reason?: string;
  stderr: string;
  failure?: string;
  claudeText: string;
  partial: string;
  claudeThinking?: { id: string; index: number };
};

const outputLimit = 60_000;
const sessionIdPattern = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const isWindows = process.platform === "win32";
const taskkill = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "taskkill.exe",
);
const taskkillArgs = (pid: number) => ["/pid", String(pid), "/t", "/f"];

function killProcessGroup(child: ChildProcessWithoutNullStreams) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill();
  }
}

export class AgentRunner {
  private runs = new Map<string, Entry>();
  private locks = new Set<string>();
  private closed = false;
  constructor(
    private directory: string,
    private onDone: () => void,
    private command = findAgent,
    private timeout = 30 * 60 * 1000,
  ) {}

  current(target: Pick<Target, "key" | "provider" | "sessionId">) {
    return (
      [...this.runs.values()]
        .reverse()
        .find(
          ({ view }) =>
            view.key === target.key ||
            (view.provider === target.provider &&
              view.sessionId === target.sessionId),
        )?.view ?? null
    );
  }

  recent() {
    return [...this.runs.values()]
      .reverse()
      .slice(0, 20)
      .map(({ view }) => summarizeAgentRun(view));
  }

  inspect(id: string) {
    return this.runs.get(id)?.view ?? null;
  }

  async start(target: Target, message: string) {
    if (!isAbsolute(target.folder))
      throw Error("Choose an absolute project folder.");
    const folder = await realpath(target.folder).catch(() => "");
    if (!folder || !(await stat(folder)).isDirectory())
      throw Error("Project folder was not found.");
    if (target.sessionId && !sessionIdPattern.test(target.sessionId))
      throw Error("Invalid session ID.");
    if (this.closed) throw Error("The session runner is closing.");
    const id = randomUUID();
    const lock = `${target.provider}:${target.sessionId?.toLowerCase() || id}`;
    if (this.locks.has(lock))
      throw Error("This session already has a running message.");
    const command = this.command(target.provider);
    const run: Entry = {
      view: {
        ...target,
        id,
        folder,
        message,
        status: "running",
        text: "",
        activity: "Checking sign-in…",
        activities: [],
        permissions: [],
      },
      lock,
      clients: new Set(),
      inputs: new Map(),
      decisions: [],
      stderr: "",
      claudeText: "",
      partial: "",
    };
    this.locks.add(lock);
    this.runs.set(id, run);
    if (this.runs.size > 80) {
      for (const [old, entry] of this.runs) {
        if (!agentBusy(entry.view)) this.runs.delete(old);
        if (this.runs.size <= 80) break;
      }
    }
    run.timer = setTimeout(
      () => this.stop(id, "Run exceeded the time limit."),
      this.timeout,
    );
    run.timer.unref();
    void this.launch(run, command);
    return run.view;
  }

  private updateActivity(run: Entry, activity: AgentActivity) {
    const list = (run.view.activities ??= []);
    const index = list.findIndex((item) => item.id === activity.id);
    const now = Date.now();
    if (index < 0) {
      list.push({
        startedAt: now,
        ...activity,
        ...(activity.status === "running" ? {} : { endedAt: now }),
      });
      if (list.length > 60) list.shift();
    } else if (
      list[index]!.status === "running" ||
      activity.status !== "running"
    ) {
      const ended =
        list[index]!.status === "running" && activity.status !== "running";
      list[index] = {
        ...list[index]!,
        ...activity,
        ...(ended ? { endedAt: now } : {}),
      };
    }
    run.view.activity =
      list.findLast((item) => item.status === "running")?.label ??
      "Waiting for model…";
  }

  private claudeTool(
    run: Entry,
    block: { id?: unknown; name?: unknown; input?: unknown },
  ) {
    if (typeof block.name !== "string") return;
    const name = block.name.slice(0, 240);
    if (typeof block.id !== "string") {
      run.view.activity = `Using ${name}`;
      return;
    }
    const mcp = /^mcp__([^]+?)__(.+)$/.exec(name);
    // The streamed start carries an empty input; the full message has it.
    const input = stepInput(block.input);
    this.updateActivity(run, {
      id: block.id,
      kind: mcp ? "mcp" : name === "Bash" ? "command" : "tool",
      label: mcp ? `${mcp[1]} / ${mcp[2]}` : name,
      status: "running",
      ...(input ? { input } : {}),
    });
  }

  private finishThinking(run: Entry) {
    if (!run.claudeThinking) return;
    this.updateActivity(run, {
      id: run.claudeThinking.id,
      kind: "reasoning",
      label: "Thinking",
      status: "completed",
    });
    run.claudeThinking = undefined;
  }

  private async launch(run: Entry, command: ReturnType<typeof findAgent>) {
    const { provider, folder, message, sessionId } = run.view;
    const env = agentEnvironment();
    try {
      await verifyAgentLogin(provider, command, folder, env);
      if (run.view.status === "stopping") return this.finish(run);
      const child = spawn(
        command.file,
        [...command.args, ...agentArgs(provider, sessionId, run.view.model)],
        {
          cwd: folder,
          env,
          windowsHide: true,
          detached: !isWindows,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      run.child = child;
      run.view.activity = "Starting…";
      this.publish(run);
      child.stdin.on("error", () => {});
      child.stderr.setEncoding("utf8").on("data", (text: string) => {
        run.stderr = (run.stderr + text).slice(-8000);
      });
      let pending = "";
      let drop = false;
      child.stdout.setEncoding("utf8").on("data", (text: string) => {
        const segments = text.split("\n");
        const last = segments.pop()!;
        for (const segment of segments) {
          if (!drop && pending.length + segment.length <= 2_000_000)
            this.record(run, pending + segment);
          pending = "";
          drop = false;
        }
        if (drop || pending.length + last.length > 2_000_000) {
          pending = "";
          drop = true;
        } else pending += last;
      });
      child.once("error", (error) => {
        run.failure = error.message;
      });
      child.once("close", (code) => {
        if (!drop && pending) this.record(run, pending);
        this.finish(
          run,
          run.failure ||
            (code === 0
              ? undefined
              : run.stderr.trim() || `CLI exited with code ${code}.`),
        );
      });
      if (provider === "claude") {
        this.write(run, {
          type: "control_request",
          request_id: randomUUID(),
          request: { subtype: "initialize" },
        });
        this.write(run, {
          type: "user",
          message: { role: "user", content: message },
          parent_tool_use_id: null,
          session_id: "",
        });
      } else child.stdin.end(message, "utf8");
    } catch (error) {
      this.finish(run, error instanceof Error ? error.message : String(error));
    }
  }

  private write(run: Entry, packet: unknown) {
    if (run.child?.stdin.writable)
      run.child.stdin.write(JSON.stringify(packet) + "\n");
  }

  private record(run: Entry, line: string) {
    if (run.view.status !== "running") return;
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (run.view.provider === "claude") this.claudeRecord(run, data);
    else this.codexRecord(run, data);
    this.publish(run);
  }

  private rememberSession(run: Entry, id: unknown) {
    if (
      run.view.sessionId ||
      typeof id !== "string" ||
      !sessionIdPattern.test(id)
    )
      return;
    run.view.sessionId = id;
    this.locks.delete(run.lock);
    run.lock = `${run.view.provider}:${id.toLowerCase()}`;
    this.locks.add(run.lock);
  }

  // Claude's CLI keeps stdin open for permission replies in stream-json mode.
  private claudeRecord(run: Entry, data: any) {
    this.rememberSession(run, data.session_id);
    if (
      data.type === "control_request" &&
      data.request?.subtype === "can_use_tool"
    ) {
      const id = data.request_id;
      const tool = data.request.tool_name;
      if (
        typeof id !== "string" ||
        typeof tool !== "string" ||
        run.inputs.has(id)
      )
        return;
      const input = JSON.stringify(data.request.input ?? {}, null, 2);
      run.inputs.set(
        id,
        input.length <= 30_000 ? (data.request.input ?? {}) : null,
      );
      run.view.permissions.push({
        id,
        tool,
        input: input.length <= 30_000 ? input : "",
      });
      return;
    }
    if (data.type === "control_cancel_request")
      this.removePermission(run, data.request_id);
    if (data.type === "stream_event") {
      const event = data.event;
      const block = event?.content_block;
      if (event?.type === "content_block_start" && block?.type === "tool_use")
        this.claudeTool(run, block);
      if (
        !data.parent_tool_use_id &&
        event?.type === "content_block_start" &&
        ["thinking", "redacted_thinking"].includes(block?.type)
      ) {
        this.finishThinking(run);
        const id = `thinking:${randomUUID()}`;
        run.claudeThinking = { id, index: event.index };
        this.updateActivity(run, {
          id,
          kind: "reasoning",
          label: "Thinking",
          status: "running",
        });
      }
      if (
        !data.parent_tool_use_id &&
        event?.type === "content_block_stop" &&
        run.claudeThinking?.index === event.index
      )
        this.finishThinking(run);
      const delta = event?.delta;
      if (
        !data.parent_tool_use_id &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        run.partial = (run.partial + delta.text).slice(-outputLimit);
        run.view.text = (run.claudeText + run.partial).slice(-outputLimit);
      }
    }
    if (data.type === "assistant" && Array.isArray(data.message?.content)) {
      const blocks = data.message.content;
      const text = blocks
        .filter((block: { type: string }) => block.type === "text")
        .map((block: { text: string }) => block.text)
        .join("\n");
      if (text && !data.parent_tool_use_id) {
        run.claudeText = (run.claudeText + text + "\n\n").slice(-outputLimit);
        run.partial = "";
        run.view.text = run.claudeText.trimEnd();
      }
      for (const block of blocks)
        if (block?.type === "tool_use") this.claudeTool(run, block);
    }
    if (data.type === "user" && Array.isArray(data.message?.content)) {
      for (const block of data.message.content) {
        if (block?.type !== "tool_result") continue;
        const activity = run.view.activities?.find(
          (item) => item.id === block.tool_use_id,
        );
        if (activity) {
          const output = stepOutput(block.content);
          this.updateActivity(run, {
            ...activity,
            status: block.is_error ? "failed" : "completed",
            ...(output ? { output } : {}),
          });
        }
      }
    }
    if (data.type === "result") {
      this.finishThinking(run);
      if (data.is_error || data.subtype !== "success")
        run.failure =
          data.result ||
          data.errors?.join("\n") ||
          data.subtype ||
          "Claude Code reported an error.";
      else if (!run.view.text && typeof data.result === "string")
        run.view.text = data.result.slice(-outputLimit);
      run.child?.stdin.end();
    }
  }

  private codexRecord(run: Entry, data: any) {
    if (data.type === "thread.started")
      this.rememberSession(run, data.thread_id);
    if (
      data.type === "item.completed" &&
      data.item?.type === "agent_message" &&
      typeof data.item.text === "string"
    )
      run.view.text = [run.view.text, data.item.text]
        .filter(Boolean)
        .join("\n\n")
        .slice(-outputLimit);
    this.codexActivity(run, data);
    if (data.type === "turn.failed")
      run.failure = data.error?.message || "Codex reported a failed turn.";
    if (data.type === "error" && typeof data.message === "string")
      run.view.activity = data.message.slice(0, 1000);
  }

  private codexActivity(run: Entry, data: any) {
    if (!["item.started", "item.updated", "item.completed"].includes(data.type))
      return;
    const item = data.item;
    if (!item || typeof item.id !== "string") return;
    const kinds: Record<string, [AgentActivity["kind"], string]> = {
      mcp_tool_call: [
        "mcp",
        `${item.server || "MCP"} / ${item.tool || "tool"}`,
      ],
      command_execution: ["command", "Shell command"],
      reasoning: ["reasoning", "Thinking"],
      web_search: ["search", "Web search"],
      file_change: ["changes", "File changes"],
      collab_tool_call: ["tool", "Agent collaboration"],
    };
    const entry = Object.hasOwn(kinds, item.type)
      ? kinds[item.type]
      : undefined;
    if (!entry) return;
    const [kind, label] = entry;
    const status =
      item.status === "failed" || item.status === "declined" || item.error
        ? "failed"
        : data.type === "item.completed"
          ? "completed"
          : "running";
    const summary =
      kind === "reasoning" && typeof item.text === "string"
        ? item.text.slice(0, 2400)
        : undefined;
    const input = stepInput(
      kind === "command"
        ? { command: item.command }
        : kind === "mcp"
          ? item.arguments
          : kind === "search"
            ? { query: item.query }
            : kind === "changes" && Array.isArray(item.changes)
              ? {
                  files: item.changes
                    .map(
                      (change: { path?: unknown; kind?: unknown }) =>
                        `${change?.kind ?? "update"} ${change?.path ?? ""}`,
                    )
                    .join("\n"),
                }
              : undefined,
    );
    const output =
      typeof item.error?.message === "string"
        ? stepOutput(item.error.message)
        : kind === "command"
          ? stepOutput(
              [
                item.aggregated_output,
                typeof item.exit_code === "number"
                  ? `Exit code ${item.exit_code}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            )
          : kind === "mcp"
            ? stepOutput(item.result?.content ?? item.result)
            : undefined;
    this.updateActivity(run, {
      id: item.id,
      kind,
      label: summary ? "Reasoning summary" : label.slice(0, 240),
      status,
      ...(summary ? { summary } : {}),
      ...(input ? { input } : {}),
      ...(output ? { output } : {}),
    });
  }

  private removePermission(run: Entry, id: string) {
    run.inputs.delete(id);
    run.view.permissions = run.view.permissions.filter(
      (request) => request.id !== id,
    );
  }

  decide(id: string, requestId: string, allow: boolean) {
    const run = this.runs.get(id);
    const request = run?.view.permissions.find(
      (permission) => permission.id === requestId,
    );
    if (
      !run ||
      run.view.status !== "running" ||
      !request ||
      (allow && !request.input)
    )
      throw Error("This approval request is unavailable.");
    const input = run.inputs.get(requestId);
    this.removePermission(run, requestId);
    run.decisions.push({ tool: request.tool, allowed: allow });
    this.write(run, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Denied by the user in Orvane." },
      },
    });
    this.publish(run, true);
  }

  subscribe(id: string, res: ServerResponse) {
    const run = this.runs.get(id);
    if (!run) return false;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    });
    res.write(this.event(run.view));
    if (agentBusy(run.view)) {
      run.clients.add(res);
      res.once("close", () => run.clients.delete(res));
    } else res.end();
    return true;
  }

  private event(view: AgentRun) {
    return `data: ${JSON.stringify(view)}\n\n`;
  }

  private publish(run: Entry, immediate = false) {
    if (immediate) {
      clearTimeout(run.updates);
      run.updates = undefined;
      const frame = this.event(run.view);
      for (const client of run.clients) {
        if (client.writableLength > 256_000) client.destroy();
        else client.write(frame);
      }
    } else if (!run.updates && run.clients.size) {
      run.updates = setTimeout(() => this.publish(run, true), 80);
    }
  }

  stop(id: string, reason?: string) {
    const run = this.runs.get(id);
    if (!run || run.view.status !== "running") return;
    run.reason = reason;
    run.view.status = "stopping";
    run.view.permissions = [];
    run.inputs.clear();
    this.publish(run, true);
    const child = run.child;
    if (!child?.pid) return;
    if (isWindows) {
      const kill = spawn(taskkill, taskkillArgs(child.pid), {
        windowsHide: true,
        stdio: "ignore",
      });
      kill.on("error", () => child.kill());
      kill.on("exit", (code) => {
        if (code && child.exitCode === null) child.kill();
      });
    } else killProcessGroup(child);
  }

  private finish(run: Entry, error?: string) {
    if (!agentBusy(run.view)) return;
    clearTimeout(run.timer);
    const stopping = run.view.status === "stopping";
    const failure = stopping ? run.reason : error;
    run.view.status = failure ? "failed" : stopping ? "stopped" : "completed";
    run.view.error =
      failure &&
      /not logged in|not authenticated|please run \/login|401 unauthorized/i.test(
        failure,
      )
        ? loginHint(run.view.provider)
        : failure?.slice(0, 8000);
    run.view.activity = "";
    for (const item of run.view.activities ?? [])
      if (item.status === "running") item.status = "interrupted";
    run.view.permissions = [];
    run.inputs.clear();
    this.locks.delete(run.lock);
    this.onDone();
    this.publish(run, true);
    for (const client of run.clients) client.end();
    run.clients.clear();
    const record = JSON.stringify({
      ...run.view,
      decisions: run.decisions,
      finishedAt: new Date().toISOString(),
    });
    const directory = join(this.directory, "agent-runs");
    void mkdir(directory, { recursive: true })
      .then(() =>
        writeFile(join(directory, `${run.view.id}.json`), record, {
          mode: 0o600,
        }),
      )
      .catch((logError) =>
        console.error("Could not save agent run log:", logError),
      );
  }

  close() {
    this.closed = true;
    for (const id of this.runs.keys()) this.stop(id);
  }

  emergencyClose() {
    for (const { child } of this.runs.values()) {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
        continue;
      if (isWindows)
        spawnSync(taskkill, taskkillArgs(child.pid), {
          windowsHide: true,
          stdio: "ignore",
          timeout: 2000,
        });
      else killProcessGroup(child);
    }
  }
}
