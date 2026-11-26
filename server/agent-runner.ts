import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ServerResponse } from "node:http";
import {
  agentBusy,
  agentNames,
  askedQuestions,
  attachmentPicture,
  claudeContext,
  codexContext,
  CODEX_QUESTION,
  splitAttachments,
  summarizeAgentRun,
  type AgentActivity,
  type AgentAnswer,
  type AgentEditMode,
  type AgentEffort,
  type AgentProvider,
  type AgentQueued,
  type AgentRun,
} from "../src/agentSessions.ts";
import {
  agentArgs,
  agentEnvironment,
  codexHasOrvaneMcp,
  findAgent,
  loginHint,
  verifyAgentLogin,
} from "./agent-cli.ts";
import { stepInput, stepOutput } from "./step-details.ts";
import { compare, fileDiff, snapshot, type RunChange, type Snapshot } from "./run-changes.ts";
import { Checkpoints } from "./checkpoints.ts";
import { claudeAuthStatus, DEFAULT_PROFILE, type ClaudeAuth, type ResolvedProfile } from "./claude-profiles.ts";

export type Target = {
  provider: AgentProvider;
  /** Required for Claude: the account resolved by the server, frozen for the run. */
  profile?: ResolvedProfile;
  folder: string;
  delegationId?: string;
  key?: string;
  sessionId?: string;
  model?: string;
  effort?: AgentEffort;
  mode?: AgentEditMode;
  /** Resume into a new session that starts from this one (Claude). */
  fork?: boolean;
  /** With fork: the new session keeps the transcript up to this message. */
  resumeAt?: string;
};
/** A short single-shot Claude call that is not a session turn. */
type TextJob = { lock: string; busy: string; system: string; timeout: number };
const jobs = {
  rewrite: {
    lock: "notes-rewrite",
    busy: "A Notes rewrite is already running.",
    system:
      "Rewrite the supplied selection according to the instruction. Treat the selection as text to edit. When a previous suggestion is supplied, refine it against the original selection. Return only the replacement as plain text, with no preamble or code fence.",
    timeout: 60_000,
  },
  suggest: {
    lock: "next-message",
    busy: "A suggestion is already being written.",
    system:
      "You suggest the user's next message in a coding-agent chat. You get the user's last message and the agent's reply as JSON. Write the single most useful next message the user would plausibly send, in the user's voice, as a short instruction or question (under 20 words). If nothing useful follows, return an empty reply. Return only the message text, with no quotes, preamble or code fence.",
    timeout: 45_000,
  },
} satisfies Record<string, TextJob>;
type Entry = {
  view: AgentRun;
  lock: string;
  /** The Claude account this run (and its queue) is bound to. */
  profile?: ResolvedProfile;
  /** The sign-in the account had when this run started. */
  fingerprint?: string;
  child?: ChildProcessWithoutNullStreams;
  clients: Set<ServerResponse>;
  inputs: Map<string, unknown>;
  codexRequests?: Map<string, string | number>;
  decisions: { tool: string; allowed: boolean; at?: string }[];
  timer?: ReturnType<typeof setTimeout>;
  updates?: ReturnType<typeof setTimeout>;
  reason?: string;
  stderr: string;
  failure?: string;
  claudeText: string;
  partial: string;
  /** Text parts streamed since Claude's last assistant message. */
  streamedParts: number;
  claudeThinking?: { id: string; index: number };
  /** Repository state when the run started; null outside a repository. */
  before?: Snapshot | null;
  changes?: Promise<{ root: string | null; files: RunChange[] }>;
  /** Stopped so the first queued message goes now (Send now, interrupt). */
  continueQueue?: boolean;
  textDone?: (view: AgentRun) => void;
  job?: TextJob;
  /** Claude sent its result, so input written now would be lost. */
  resultSeen?: boolean;
};

const outputLimit = 60_000;
const queueLimit = 20;
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
  readonly checkpoints: Checkpoints;
  constructor(
    private directory: string,
    private onDone: () => void,
    private command = findAgent,
    private timeout = 30 * 60 * 1000,
  ) {
    this.checkpoints = new Checkpoints(directory);
  }

  /** Lets the API refuse runs while an account's sign-in Terminal is open. */
  loginActive?: (profileId: string) => boolean;
  /** Recheck the registry after async folder validation and before registering
   * any chat, queued turn or text job with an already-resolved account. */
  validateProfile?: (profileId: string) => void;
  /** The trusted transcript path to resume a session of one account. */
  resumePath?: (profile: ResolvedProfile, sessionId: string, key?: string) => Promise<string>;
  /** Each Claude run reports the account's sign-in it found. */
  onAuth?: (profileId: string, auth: ClaudeAuth) => void;

  current(target: Pick<Target, "key" | "provider" | "sessionId"> & { profileId?: string }) {
    const profileId = target.profileId ?? DEFAULT_PROFILE;
    return (
      [...this.runs.values()]
        .reverse()
        .find(
          ({ view }) =>
            (!!target.key && view.key === target.key) ||
            (view.provider === target.provider &&
              !!target.sessionId &&
              view.sessionId === target.sessionId &&
              (view.provider !== "claude" || (view.profileId ?? DEFAULT_PROFILE) === profileId)),
        )?.view ?? null
    );
  }

  /** Claude runs of one account that are still working. */
  busyCount(profileId: string) {
    let count = 0;
    for (const { view, profile } of this.runs.values())
      if (view.provider === "claude" && profile?.id === profileId && agentBusy(view)) count++;
    return count;
  }

  recent() {
    return [...this.runs.values()]
      .reverse()
      .filter((run) => !run.textDone)
      .slice(0, 20)
      .map(({ view }) => summarizeAgentRun(view));
  }

  hasActiveTurns() {
    return [...this.runs.values()].some(({ view }) => agentBusy(view));
  }

  inspect(id: string) {
    return this.runs.get(id)?.view ?? null;
  }

  /** Approvals given in one session, read from the saved run logs. */
  async approvals(sessionId: string, profileId?: string, provider: AgentProvider = "claude") {
    // The same Claude session UUID may exist in two accounts' folders.
    const mine = (record: { provider?: string; profileId?: string }) =>
      (record.provider ?? "claude") === provider &&
      (provider !== "claude" || (record.profileId ?? DEFAULT_PROFILE) === (profileId ?? DEFAULT_PROFILE));
    const directory = join(this.directory, "agent-runs");
    const names = await readdir(directory).catch(() => [] as string[]);
    const files = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .slice(-2000)
        .map(async (name) => {
          const path = join(directory, name);
          return { path, mtime: (await stat(path).catch(() => null))?.mtimeMs ?? 0 };
        }),
    );
    // The newest 300 logs are enough for a session's overview.
    files.sort((a, b) => b.mtime - a.mtime);
    const found: { tool: string; allowed: boolean; at: string; runId: string }[] = [];
    for (const { path } of files.slice(0, 300)) {
      const record = await readFile(path, "utf8")
        .then((text) => JSON.parse(text) as { id?: string; sessionId?: string; provider?: string; profileId?: string; decisions?: Entry["decisions"]; finishedAt?: string })
        .catch(() => null);
      if (!record || record.sessionId !== sessionId || !mine(record) || !Array.isArray(record.decisions)) continue;
      for (const decision of record.decisions)
        if (typeof decision?.tool === "string")
          found.push({
            tool: decision.tool,
            allowed: decision.allowed === true,
            at: decision.at ?? record.finishedAt ?? "",
            runId: String(record.id ?? ""),
          });
    }
    // Runs still open have not written a log yet.
    for (const entry of this.runs.values())
      if (entry.view.sessionId === sessionId && mine(entry.view))
        for (const decision of entry.decisions)
          found.push({ tool: decision.tool, allowed: decision.allowed, at: decision.at ?? "", runId: entry.view.id });
    const unique = new Map(found.map((item) => [`${item.runId}|${item.at}|${item.tool}`, item]));
    return [...unique.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Checkpoints saved before the turns of one session, oldest first. */
  async sessionCheckpoints(sessionId: string, profileId?: string, provider: AgentProvider = "claude") {
    const directory = join(this.directory, "agent-runs");
    const names = await readdir(directory).catch(() => [] as string[]);
    const files = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .slice(-2000)
        .map(async (name) => {
          const path = join(directory, name);
          return { path, mtime: (await stat(path).catch(() => null))?.mtimeMs ?? 0 };
        }),
    );
    files.sort((a, b) => b.mtime - a.mtime);
    type Found = { runId: string; commit: string; at: string; message: string; folder: string };
    const found = new Map<string, Found>();
    const add = (view: Partial<AgentRun>) => {
      if (view.sessionId !== sessionId || !view.checkpoint?.commit || !view.id) return;
      if ((view.provider ?? "claude") !== provider ||
          (provider === "claude" && (view.profileId ?? DEFAULT_PROFILE) !== (profileId ?? DEFAULT_PROFILE))) return;
      found.set(view.id, {
        runId: view.id,
        commit: view.checkpoint.commit,
        at: view.checkpoint.at,
        message: String(view.message ?? "").slice(0, 400),
        folder: String(view.folder ?? ""),
      });
    };
    for (const { path } of files.slice(0, 400)) {
      const record = await readFile(path, "utf8")
        .then((text) => JSON.parse(text) as Partial<AgentRun>)
        .catch(() => null);
      if (record) add(record);
    }
    for (const entry of this.runs.values()) add(entry.view);
    return [...found.values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  async start(target: Target, message: string, runId?: string) {
    if (!isAbsolute(target.folder))
      throw Error("Choose an absolute project folder.");
    const folder = await realpath(target.folder).catch(() => "");
    if (!folder || !(await stat(folder)).isDirectory())
      throw Error("Project folder was not found.");
    return this.startInFolder({ ...target, folder }, message, undefined, undefined, runId);
  }

  async rewrite(profile: ResolvedProfile, folder: string, message: string, signal: AbortSignal) {
    const result = await this.textJob(jobs.rewrite, profile, folder, message, signal);
    if (!result.text) throw Error("Claude Code did not return a rewrite.");
    return result;
  }

  /** One suggested next message for a finished turn; empty when none fits. */
  async suggest(profile: ResolvedProfile, folder: string, message: string, signal: AbortSignal) {
    const result = await this.textJob(jobs.suggest, profile, folder, message, signal);
    return result.text.split("\n", 1)[0]!.replace(/^["'`]+|["'`]+$/g, "").trim().slice(0, 400);
  }

  private async textJob(job: TextJob, profile: ResolvedProfile, folder: string, message: string, signal: AbortSignal) {
    signal.throwIfAborted();
    let finish!: (view: AgentRun) => void;
    const done = new Promise<AgentRun>((resolve) => { finish = resolve; });
    const started = this.startInFolder(
      { provider: "claude", profile, folder, model: "haiku", mode: "plan" },
      message,
      finish,
      job,
    );
    const abort = () => this.stop(started.id);
    signal.addEventListener("abort", abort, { once: true });
    try {
      const result = await done;
      if (result.status !== "completed")
        throw Error(result.error || "Claude Code did not answer.");
      return { text: result.text.trim(), model: result.context?.model || "Haiku" };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private startInFolder(target: Target, message: string, textDone?: Entry["textDone"], job?: TextJob, id: string = randomUUID()) {
    if (target.sessionId && !sessionIdPattern.test(target.sessionId))
      throw Error("Invalid session ID.");
    if (this.closed) throw Error("The session runner is closing.");
    if (this.runs.has(id)) throw Error("This run ID is already in use.");
    const { profile, ...rest } = target;
    // Every Claude path (chats, queues, forks, schedules, text jobs) names its
    // account; there is no implicit fallback to Default here.
    if (target.provider === "claude" && !profile) throw Error("Choose a Claude account for this chat.");
    if (target.provider !== "claude" && profile) throw Error("Only Claude chats use Claude accounts.");
    if (profile) this.validateProfile?.(profile.id);
    if (profile && this.loginActive?.(profile.id))
      throw Error(`A sign-in for ${profile.name} is open in a Terminal. Finish or cancel it first.`);
    const lock = job ? job.lock : this.lockKey(target.provider, profile?.id, target.sessionId?.toLowerCase() || id);

    if (this.locks.has(lock))
      throw Error(job ? job.busy : "This session already has a running message.");
    const command = this.command(target.provider);
    const run: Entry = {
      profile,
      view: {
        ...rest,
        ...(profile ? { profileId: profile.id } : {}),
        id,
        message,
        status: "running",
        text: "",
        activity: "Checking sign-in…",
        activities: [],
        permissions: [],
        startedAt: Date.now(),
      },
      lock,
      textDone,
      job,
      clients: new Set(),
      inputs: new Map(),
      decisions: [],
      stderr: "",
      claudeText: "",
      partial: "",
      streamedParts: 0,
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
      job ? job.timeout : this.timeout,
    );
    run.timer.unref();
    void this.launch(run, command);
    return run.view;
  }

  /** Claude sessions are locked per account: the same UUID may live in two roots. */
  private lockKey(provider: AgentProvider, profileId: string | undefined, session: string) {
    return provider === "claude" ? `claude:${profileId}:${session}` : `${provider}:${session}`;
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

  /** Text the agent writes while it works, placed after the step it
   * followed, so the live chat reads in the order the work happened. */
  private addTextPart(run: Entry, text: string) {
    const parts = (run.view.textParts ??= []);
    parts.push({ after: run.view.activities?.at(-1)?.id ?? "", text: text.slice(-outputLimit) });
    if (parts.length > 60) parts.shift();
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
    // A Claude run uses the env frozen with its account; Codex is unchanged.
    const env: NodeJS.ProcessEnv = run.profile ? { ...run.profile.env } : agentEnvironment();
    if (run.view.delegationId) env.ORVANE_DELEGATED_RUN = run.view.delegationId;

    const codexPlan = provider === "codex" && run.view.mode === "plan";
    const images = provider === "codex"
      ? splitAttachments(message).paths.filter((path) => isAbsolute(path) && attachmentPicture(path))
      : [];
    try {
      let resume = sessionId;
      if (run.profile) {
        const auth = await claudeAuthStatus(command, run.profile, folder);
        this.onAuth?.(run.profile.id, auth);
        if (!auth.loggedIn) throw Error(`${run.profile.name}: not signed in. ${loginHint("claude")}`);
        if (!auth.supported) throw Error(`${run.profile.name}: ${auth.error}`);
        run.fingerprint = auth.fingerprint;
        // Resume only from this account's own transcript file; never by a
        // bare ID the CLI might find somewhere else, never from Default.
        if (sessionId && !run.textDone) {
          if (!this.resumePath) throw Error("Orvane can't locate this chat's transcript.");
          resume = await this.resumePath(run.profile, sessionId, run.view.key);
        }
      } else await verifyAgentLogin(provider, command, folder, env);
      if (run.view.status === "stopping") return this.finish(run);
      if (!run.textDone) {
        const label = message.trim().split("\n", 1)[0]!.slice(0, 120) || "Turn";
        const [before, checkpoint] = await Promise.all([
          snapshot(folder).catch(() => null),
          this.checkpoints.create(folder, label),
        ]);
        run.before = before;
        if (checkpoint) run.view.checkpoint = checkpoint;
      }
      // A Stop may arrive while the snapshot is read.
      if ((run.view.status as AgentRun["status"]) === "stopping") return this.finish(run);
      const child = spawn(
        command.file,
        [
          ...command.args,
          ...(codexPlan ? [
            "-c", 'model_provider="openai"',
            "-c", "sandbox_workspace_write.network_access=false",
            "app-server", "--listen", "stdio://",
          ] : agentArgs(
            provider, resume, run.view.model, run.view.effort, run.view.mode, run.view.fork, run.view.resumeAt,
            provider === "codex" && run.view.mode === "full" && codexHasOrvaneMcp(env),
            images,
          )),
          ...(run.job ? [
            "--safe-mode", "--no-session-persistence", "--tools", "",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--disallowedTools", "mcp__*", "--max-turns", "1",
            "--system-prompt", run.job.system,
          ] : []),
        ],
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
      // Until the CLI answers, the run is only waiting on it.
      run.view.activity = `Waiting for ${agentNames[run.view.provider]}`;
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
            (codexPlan && !run.resultSeen && code === 0
              ? run.stderr.trim() || "Codex app-server quit before the turn finished."
              : code === 0 || (codexPlan && run.resultSeen)
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
      } else if (codexPlan) {
        this.write(run, {
          id: "initialize", method: "initialize",
          params: {
            clientInfo: { name: "orvane", title: "Orvane", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          },
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
    else if (run.view.mode === "plan") this.codexPlanRecord(run, data);
    else this.codexRecord(run, data);
    this.publish(run);
  }

  private rememberSession(run: Entry, id: unknown) {
    if (
      run.textDone ||
      run.view.sessionId ||
      typeof id !== "string" ||
      !sessionIdPattern.test(id)
    )
      return;
    run.view.sessionId = id;
    this.locks.delete(run.lock);
    run.lock = this.lockKey(run.view.provider, run.profile?.id, id.toLowerCase());
    this.locks.add(run.lock);
  }

  // Claude's CLI keeps stdin open for permission replies in stream-json mode.
  /** Claude's subscription limits, as it reports them during a run. */
  onClaudeUsage?: (event: unknown, profileId: string, fingerprint: string) => void;
  private claudeRecord(run: Entry, data: any) {
    if (data?.type === "rate_limit_event") {
      // Limits belong to the account (and sign-in) this run started with.
      if (run.profile && run.fingerprint) this.onClaudeUsage?.(data, run.profile.id, run.fingerprint);
      return;
    }
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
      // A new text block starts a new part, after the latest step.
      if (!data.parent_tool_use_id && event?.type === "content_block_start" && block?.type === "text") {
        this.addTextPart(run, "");
        run.streamedParts++;
      }
      const delta = event?.delta;
      if (
        !data.parent_tool_use_id &&
        delta?.type === "text_delta" &&
        typeof delta.text === "string"
      ) {
        run.partial = (run.partial + delta.text).slice(-outputLimit);
        run.view.text = (run.claudeText + run.partial).slice(-outputLimit);
        // Text with no block start of its own still gets a part.
        if (!run.streamedParts) {
          this.addTextPart(run, "");
          run.streamedParts++;
        }
        const part = run.view.textParts!.at(-1)!;
        part.text = (part.text + delta.text).slice(-outputLimit);
      }
    }
    if (data.type === "assistant" && !data.parent_tool_use_id) {
      const context = claudeContext(data.message?.usage, data.message?.model, run.view.model);
      if (context) run.view.context = context;
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
        // Streamed already, block by block; otherwise it arrives whole here.
        const streamed = run.streamedParts
          ? (run.view.textParts ?? []).slice(-run.streamedParts).map((part) => part.text).join("")
          : "";
        if (streamed.replace(/\s+/g, "") !== text.replace(/\s+/g, "")) this.addTextPart(run, text);
      }
      if (!data.parent_tool_use_id) run.streamedParts = 0;
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
      const context = run.view.context;
      const window = context?.model && data.modelUsage?.[context.model]?.contextWindow;
      if (context && typeof window === "number" && Number.isFinite(window) && window > 0) {
        context.window = window;
        delete context.estimatedWindow;
      }
      this.finishThinking(run);
      if (data.is_error || data.subtype !== "success")
        run.failure =
          data.result ||
          data.errors?.join("\n") ||
          data.subtype ||
          "Claude Code reported an error.";
      else if (!run.view.text && typeof data.result === "string")
        run.view.text = data.result.slice(-outputLimit);
      run.resultSeen = true;
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
    ) {
      run.view.text = [run.view.text, data.item.text]
        .filter(Boolean)
        .join("\n\n")
        .slice(-outputLimit);
      this.addTextPart(run, data.item.text);
    }
    this.codexActivity(run, data);
    if (data.type === "turn.failed")
      run.failure = data.error?.message || "Codex reported a failed turn.";
    if (data.type === "error" && typeof data.message === "string")
      run.view.activity = data.message.slice(0, 1000);
  }

  private codexPlanRecord(run: Entry, data: any) {
    const { id, method, params, result, error } = data;
    if (typeof id === "number" || typeof id === "string") {
      if (typeof method === "string") {
        if (method === "item/tool/requestUserInput") {
          const requestId = `codex:${typeof id}:${id}`;
          const input = JSON.stringify({ questions: params?.questions });
          const permission = { id: requestId, tool: CODEX_QUESTION, input };
          if (input.length <= 30_000 && askedQuestions(permission)) {
            const requests = (run.codexRequests ??= new Map());
            if (requests.has(requestId)) return;
            requests.set(requestId, id);
            run.view.permissions.push(permission);
            return;
          }
          this.write(run, { id, result: { answers: {} } });
        } else {
          this.write(run, { id, error: { code: -32601, message: "Request unavailable in Orvane Plan mode." } });
        }
        return;
      }
      if (error && ["initialize", "thread", "turn"].includes(String(id))) {
        run.failure = error.message || "Codex app-server rejected the turn.";
        run.child?.stdin.end();
        return;
      }
      if (id === "initialize") {
        this.write(run, { method: "initialized" });
        const { sessionId, folder, model } = run.view;
        this.write(run, { id: "thread", method: sessionId ? "thread/resume" : "thread/start",
          params: {
            cwd: folder, sandbox: "read-only", approvalPolicy: "never", model,
            ...(sessionId ? { threadId: sessionId, excludeTurns: true } : {}),
          },
        });
      } else if (id === "thread" && result?.thread?.id && typeof result.model === "string") {
        this.rememberSession(run, result.thread.id);
        const { message, effort } = run.view;
        const images = splitAttachments(message).paths.filter((path) => isAbsolute(path) && attachmentPicture(path));
        this.write(run, {
          id: "turn", method: "turn/start",
          params: {
            threadId: result.thread.id,
            input: [{ type: "text", text: message }, ...images.map((path) => ({ type: "localImage", path }))],
            collaborationMode: { mode: "plan", settings: { model: result.model, reasoning_effort: effort === "max" ? "xhigh" : effort } },
          },
        });
      } else if (id === "thread") {
        run.failure = "Codex did not return a session and model.";
        run.child?.stdin.end();
      }
      return;
    }
    if (method === "serverRequest/resolved") {
      this.removePermission(run, `codex:${typeof params?.requestId}:${params?.requestId}`);
      return;
    }
    if (method === "turn/completed") {
      run.resultSeen = true;
      if (params?.turn?.status === "interrupted") run.view.status = "stopping";
      else if (params?.turn?.status !== "completed")
        run.failure = params?.turn?.error?.message || "Codex reported a failed turn.";
      run.child?.stdin.end();
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = params?.tokenUsage;
      const last = usage?.last;
      if (last) run.view.context = codexContext({
        model_context_window: usage.modelContextWindow,
        last_token_usage: {
          input_tokens: last.inputTokens, cached_input_tokens: last.cachedInputTokens, output_tokens: last.outputTokens,
        },
      });
      return;
    }
    if ((method === "item/started" || method === "item/completed") && params?.item) {
      const item = params.item;
      const names: Record<string, string> = {
        agentMessage: "agent_message", mcpToolCall: "mcp_tool_call", commandExecution: "command_execution",
        fileChange: "file_change", webSearch: "web_search", collabAgentToolCall: "collab_tool_call",
      };
      this.codexRecord(run, {
        type: method.replace("/", "."),
        item: { ...item, type: Object.hasOwn(names, item.type) ? names[item.type] : item.type,
          text: item.type === "reasoning" ? item.summary?.join("\n") : item.text,
          aggregated_output: item.aggregatedOutput, exit_code: item.exitCode },
      });
    }
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
      imageView: ["tool", "Viewed image"],
      contextCompaction: ["tool", "Compacted context"],
      plan: ["tool", "Plan"],
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
              : item.type === "imageView" ? { file_path: item.path } : undefined,
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
            : item.type === "plan" ? stepOutput(item.text) : undefined;
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
    run.codexRequests?.delete(id);
    run.inputs.delete(id);
    run.view.permissions = run.view.permissions.filter(
      (request) => request.id !== id,
    );
  }

  /** Allow or deny a request. Claude's AskUserQuestion is allowed with the
   * owner's answers, which Claude reads from the tool's updated input. */
  decide(id: string, requestId: string, allow: boolean, answer?: AgentAnswer) {
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
    const asks = request.tool === "AskUserQuestion";
    if (request.tool === CODEX_QUESTION) {
      const rpcId = run.codexRequests?.get(requestId);
      const questions = askedQuestions(request);
      if (rpcId === undefined || !questions) throw Error("This Codex question is unavailable.");
      const answers = Object.fromEntries(allow ? questions.map((question) => {
        const key = question.id!;
        const value = answer?.answers[key];
        if (typeof value !== "string" || !value.trim()) throw Error("Answer the questions first.");
        if (question.other === false && !question.options.some((option) => option.label === value))
          throw Error("Choose one of the supplied answers.");
        return [key, { answers: [value] }];
      }) : []);
      this.removePermission(run, requestId);
      run.decisions.push({ tool: request.tool, allowed: allow, at: new Date().toISOString() });
      this.write(run, { id: rpcId, result: { answers } });
      this.publish(run, true);
      return;
    }
    if (answer && !asks) throw Error("Only questions take answers.");
    if (allow && asks && !answer) throw Error("Answer the questions first.");
    const original = run.inputs.get(requestId);
    const input =
      allow && answer
        ? {
            ...(original ?? {}),
            answers: answer.answers,
            ...(answer.annotations && Object.keys(answer.annotations).length
              ? { annotations: answer.annotations }
              : {}),
          }
        : original;
    this.removePermission(run, requestId);
    run.decisions.push({ tool: request.tool, allowed: allow, at: new Date().toISOString() });
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

  /** Files the finished run created, changed or deleted. */
  changes(id: string) {
    const run = this.runs.get(id);
    if (!run) throw Error("Run was not found.");
    if (agentBusy(run.view)) throw Error("The run is still working.");
    run.changes ??= (async () => {
      const after = run.before ? await snapshot(run.view.folder).catch(() => null) : null;
      if (run.before && after) return { root: after.root, files: compare(run.before, after) };
      // Outside a repository: the files its edit steps named.
      const named = new Set<string>();
      for (const item of run.view.activities ?? [])
        if (item.status === "completed" && item.input?.file_path && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(item.label))
          named.add(item.input.file_path);
      return {
        root: null,
        files: [...named].slice(0, 200).map((path) => ({ path, status: "M" as const, add: 0, del: 0 })),
      };
    })();
    return run.changes;
  }

  async diff(id: string, path: string) {
    const { root, files } = await this.changes(id);
    const change = files.find((file) => file.path === path);
    if (!root || !change) throw Error("That file is not among this run's changes.");
    return fileDiff(root, change);
  }

  /**
   * Steer: a queued message reaches a working Claude run now, between its
   * tool calls, without stopping it. Codex reads its prompt once, so it can't.
   */
  steer(id: string, queueId: string) {
    const run = this.runs.get(id);
    const item = run?.view.queued?.find((entry) => entry.id === queueId);
    if (!run || !item) throw Error("That queued message is no longer waiting.");
    if (run.view.provider !== "claude")
      throw Error("Codex can't take a message mid-turn. Use Send now instead.");
    if (run.view.status !== "running" || run.resultSeen || !run.child?.stdin.writable)
      throw Error("The turn is finishing, so the message stays queued.");
    this.write(run, {
      type: "user",
      message: { role: "user", content: item.text },
      parent_tool_use_id: null,
      session_id: run.view.sessionId ?? "",
    });
    run.view.queued = run.view.queued!.filter((entry) => entry !== item);
    (run.view.steered ??= []).push({ text: item.text, at: new Date().toISOString() });
    this.publish(run, true);
    return run.view;
  }

  /** Queue a message for when the run ends; first: send it before the rest. */
  enqueue(id: string, text: string, first = false) {
    const run = this.runs.get(id);
    if (!run) throw Error("Run was not found.");
    if (run.view.status !== "running")
      throw Error("This run has ended. Send the message instead.");
    const queued = (run.view.queued ??= []);
    if (queued.length >= queueLimit)
      throw Error(`At most ${queueLimit} messages can wait for one run.`);
    const item: AgentQueued = { id: randomUUID(), text };
    if (first) queued.unshift(item);
    else queued.push(item);
    this.publish(run, true);
    return run.view;
  }

  unqueue(id: string, queueId: string) {
    const run = this.runs.get(id);
    if (!run) throw Error("Run was not found.");
    run.view.queued = (run.view.queued ?? []).filter((item) => item.id !== queueId);
    this.publish(run, true);
    return run.view;
  }

  /**
   * Send one queued message now: a working run stops and the message goes
   * when it has; a run that already ended starts it straight away.
   */
  sendQueued(id: string, queueId: string) {
    const run = this.runs.get(id);
    const item = run?.view.queued?.find((entry) => entry.id === queueId);
    if (!run || !item) throw Error("That queued message is no longer waiting.");
    run.view.queued = [item, ...run.view.queued!.filter((entry) => entry !== item)];
    if (agentBusy(run.view)) {
      run.continueQueue = true;
      if (run.view.status === "running") this.stop(id);
      else this.publish(run, true);
      return run.view;
    }
    run.view.queued.shift();
    try {
      return this.followUp(run, item);
    } finally {
      this.publish(run, true);
    }
  }

  /** Start a queued message in the same session; the rest of the queue moves with it. */
  private followUp(run: Entry, item: AgentQueued) {
    const { provider, folder, key, sessionId, model, effort, mode, delegationId } = run.view;
    if (!sessionId) {
      run.view.queued = [item, ...(run.view.queued ?? [])];
      throw Error("The session has no ID yet, so the queued message was kept.");
    }
    try {
      // This folder was resolved when the first message started. Hand over the
      // queue before clients can see the finished run or start another message.
      // The queue stays on the account this run was bound to.
      const next = this.startInFolder(
        { provider, profile: run.profile, folder, key, sessionId, model, effort, mode, delegationId },

        item.text,
      );
      if (run.view.queued?.length) next.queued = run.view.queued;
      run.view.queued = [];
      run.view.next = next.id;
      return next;
    } catch (error) {
      run.view.queued = [item, ...(run.view.queued ?? [])];
      throw error;
    }
  }

  stop(id: string, reason?: string) {
    const run = this.runs.get(id);
    if (!run || run.view.status !== "running") return;
    run.reason = reason;
    run.view.status = "stopping";
    run.view.permissions = [];
    run.inputs.clear();
    run.codexRequests?.clear();
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
    run.view.endedAt = Date.now();
    for (const item of run.view.activities ?? [])
      if (item.status === "running") item.status = "interrupted";
    run.view.permissions = [];
    run.inputs.clear();
    run.codexRequests?.clear();
    this.locks.delete(run.lock);
    if (run.textDone) {
      this.runs.delete(run.view.id);
      run.textDone(run.view);
      return;
    }
    this.onDone();
    const close = () => {
      this.publish(run, true);
      for (const client of run.clients) client.end();
      run.clients.clear();
    };
    // A completed turn (or one stopped for Send now) passes on its queue; a
    // failed or plainly stopped one keeps it for the user to decide.
    const drain =
      !!run.view.queued?.length &&
      !this.closed &&
      (run.view.status === "completed" ||
        (run.view.status === "stopped" && run.continueQueue));
    if (drain) {
      const item = run.view.queued!.shift()!;
      try {
        this.followUp(run, item);
      } catch (cause) {
        run.view.error = `The queued message was not sent: ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    close();
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
