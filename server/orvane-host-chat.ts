import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import {
  agentBusy, agentEditModes, agentNames, askedQuestions, splitAttachments,
  type AgentEditMode, type AgentProvider, type AgentRun,
} from "../src/agentSessions.ts";
import type { AgentSession } from "../src/exposition.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { LocalDatabase } from "./database.ts";
import type { SessionTranscripts } from "./session-transcripts.ts";

export const hostProjectList = z.array(z.string().min(1).max(2000)).min(1).max(32);
export const hostSessionId = z.string().regex(/^(?:[a-f0-9]{64}|new-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/);
const prompt = z.string().trim().min(1).max(12_000);
export const hostChatAction = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("send"), session: hostSessionId, requestId: z.uuid(),
    message: prompt,
  }),
  z.strictObject({
    action: z.literal("start"), project: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.uuid(),
    provider: z.enum(["claude", "codex"]),
    model: z.string().max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).optional(),
    message: prompt,
  }),
  z.strictObject({ action: z.literal("stop"), session: hostSessionId, runId: z.uuid() }),
  z.strictObject({
    action: z.literal("approval"), session: hostSessionId, runId: z.uuid(),
    approvalId: z.string().min(1).max(300), allow: z.boolean(),
    answers: z.record(z.string().min(1).max(2000), z.string().trim().min(1).max(4000)).optional(),
  }),
]);

/** App data key for the desktop's default edit mode per CLI. */
export const defaultModesKey = "agent-default-modes";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sessionId = (session: AgentSession) => hash(`${session.provider ?? "claude"}\0${session.key}`);
const plain = (text: string) => splitAttachments(text).text.slice(0, 12_000);
const provider = (session: AgentSession) => session.provider ?? "claude";

export class HostChatError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type SendResult = { runId: string; session?: string };
type SendReceipt = SendResult & { fingerprint: string; accepted?: true; error?: string };
type ChatTarget = { session?: AgentSession; folder: string; run?: AgentRun | null };

export class HostAgentChat {
  private roots: Promise<string[]>;
  private database?: LocalDatabase;
  private starting = new Map<string, Promise<SendResult>>();

  constructor(
    projects: string[],
    private transcripts: Record<"claude" | "codex", SessionTranscripts>,
    private runner: AgentRunner,
    private databaseFile: string,
    private approvals = false,
  ) {
    this.roots = Promise.all(hostProjectList.parse(projects).map(async (path) => {
      if (!isAbsolute(path)) throw Error("Host projects must use absolute paths.");
      const folder = await realpath(path);
      if (!(await stat(folder)).isDirectory()) throw Error("Host projects must be directories.");
      return folder;
    }));
  }

  async ready() { await this.roots; }

  async allowedFolder(path: string) {
    if (!isAbsolute(path)) return;
    const folder = await realpath(path).catch(() => undefined);
    if (!folder) return;
    const roots = await this.roots;
    if (roots.some((root) => {
      const fromRoot = relative(root, folder);
      return !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(".." + sep);
    })) return folder;
  }

  private async allSessions() {
    const lists = await Promise.all([this.transcripts.claude.list(), this.transcripts.codex.list()]);
    return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async sessions() {
    const folders = new Map<string, string | undefined>();
    const visible = [];
    for (const session of await this.allSessions()) {
      if (!folders.has(session.project))
        folders.set(session.project, await this.allowedFolder(session.project));
      if (!folders.get(session.project)) continue;
      const run = this.runner.current({ ...session, provider: provider(session) });
      visible.push({
        id: sessionId(session), title: session.title, provider: agentNames[provider(session)],
        kind: provider(session), updatedAt: session.updatedAt, project: basename(folders.get(session.project)!),
        ...(agentBusy(run) ? { state: run!.permissions.length ? "approval" : "running" } : {}),
      });
      if (visible.length >= 100) break;
    }
    return visible;
  }

  async projects() {
    return (await this.roots).map((folder) => ({ id: hash(folder), name: basename(folder) || "Shared folder" }));
  }

  private async find(opaqueId: string): Promise<ChatTarget> {
    const all = await this.allSessions();
    if (opaqueId.startsWith("new-")) {
      const receipt = (this.database ??= new LocalDatabase(this.databaseFile)).appData(
        "host-chat:" + opaqueId.slice(4),
      ) as SendReceipt | undefined;
      const run = receipt?.session === opaqueId && this.runner.inspect(receipt.runId);
      const folder = run && await this.allowedFolder(run.folder);
      if (!run || !folder) throw new HostChatError(404, "This run is no longer live. Reopen its saved session.");
      const session = run.sessionId
        ? all.find((candidate) => candidate.sessionId === run.sessionId && provider(candidate) === run.provider)
        : undefined;
      const savedFolder = session && await this.allowedFolder(session.project);
      return { session: savedFolder === folder ? session : undefined, folder, run };
    }
    const session = all.find((candidate) => sessionId(candidate) === opaqueId);
    const folder = session && await this.allowedFolder(session.project);
    if (!session || !folder) throw new HostChatError(404, "That session is unavailable on this host.");
    return { session, folder, run: this.runner.current({ ...session, provider: provider(session) }) };
  }

  /** Edit mode a send uses: the chat's latest turn, else the desktop default. */
  private modeFor(kind: AgentProvider, lastMode?: AgentEditMode) {
    const db = (this.database ??= new LocalDatabase(this.databaseFile));
    const saved = (db.appData(defaultModesKey) as Partial<Record<AgentProvider, AgentEditMode>> | undefined)?.[kind];
    return [lastMode, saved].find((mode) => mode && agentEditModes[kind].includes(mode)) ?? agentEditModes[kind][0]!;
  }

  defaultModes() {
    return { claude: this.modeFor("claude"), codex: this.modeFor("codex") };
  }

  async read(id: string) {
    const { session, run, folder } = await this.find(id);
    const { messages } = session
      ? await this.transcripts[provider(session)].read({ key: session.key, limit: 40 })
      : { messages: [] };
    const thread: { id: string; role: string; text: string; at?: string }[] = messages
      .map(({ id, role, text, at }) => ({ id, role, text: plain(text), at })).filter(({ text }) => text);
    if (run) {
      // The provider can publish its live reply before its transcript is
      // flushed. Keep that tail visible until the file catches up.
      const latestUser = messages.findLastIndex(({ role }) => role === "user");
      const user = messages[latestUser];
      const text = plain(run.message);
      const at = user && Date.parse(user.at);
      if (!run.endedAt || !at || at <= run.endedAt + 1000) {
        const recorded = !!user && plain(user.text).trim() === text.trim() && (!at || at >= (run.startedAt ?? 0) - 1000);
        if (!recorded) thread.push({ id: run.id + ":prompt", role: "user", text });
        if (run.text && (!recorded || !messages.slice(latestUser + 1).some(({ role }) => role === "assistant")))
          thread.push({ id: run.id + ":reply", role: "assistant", text: plain(run.text) });
      }
    }
    const pending = run?.permissions[0];
    return {
      title: session?.title ?? plain(run!.message).split("\n")[0]!.slice(0, 140),
      provider: agentNames[session ? provider(session) : run!.provider], messages: thread,
      project: basename(folder),
      mode: this.modeFor(session ? provider(session) : run!.provider, run?.mode),
      savedSession: id.startsWith("new-") && session ? sessionId(session) : undefined,
      run: run ? { id: run.id, status: run.status, busy: agentBusy(run), awaitingApproval: !!run.permissions.length } : null,
      approval: this.approvals && pending ? {
        id: pending.id, tool: pending.tool,
        input: pending.input && pending.input.length <= 24_000 ? pending.input : null,
        questions: askedQuestions(pending),
      } : null,
    };
  }

  async act(input: z.infer<typeof hostChatAction>) {
    if (input.action === "stop" || input.action === "approval") {
      const { run } = await this.find(input.session);
      if (run?.id !== input.runId || !agentBusy(run))
        throw new HostChatError(409, "That turn has already changed or finished.");
      if (input.action === "stop") this.runner.stop(run.id);
      else {
        if (!this.approvals) throw new HostChatError(403, "Answer this request on the desktop.");
        const pending = run.permissions.find(({ id }) => id === input.approvalId);
        if (!pending) throw new HostChatError(409, "This approval is no longer pending.");
        const questions = askedQuestions(pending);
        if (input.allow && (!pending.input || pending.input.length > 24_000))
          throw new HostChatError(409, "Review the full request on the desktop.");
        let answers: Record<string, string> | undefined;
        if (input.allow && questions) {
          answers = Object.fromEntries(questions.map((q) => {
            const key = q.id ?? q.question;
            const answer = input.answers?.[key];
            if (!answer) throw new HostChatError(400, "Answer all the questions first.");
            if (q.other === false && !q.options.some(({ label }) => label === answer))
              throw new HostChatError(400, "Choose one of the supplied answers.");
            return [key, answer];
          }));
        }
        try {
          this.runner.decide(run.id, pending.id, input.allow, answers ? { answers } : undefined);
        } catch {
          throw new HostChatError(409, "This approval could not be applied. Check the desktop session.");
        }
      }
      return { runId: run.id };
    }

    if (splitAttachments(input.message).paths.length)
      throw new HostChatError(400, "Send attachments from desktop Agent Sessions.");
    const requestId = input.requestId.toLowerCase();
    let target: Parameters<AgentRunner["start"]>[0];
    let lastMode: AgentEditMode | undefined;
    if (input.action === "start") {
      const root = (await this.roots).find((folder) => hash(folder) === input.project);
      const folder = root && await this.allowedFolder(root);
      if (!folder) throw new HostChatError(404, "Choose a shared project.");
      target = { folder, provider: input.provider, model: input.model };
    } else {
      const { session, folder, run } = await this.find(input.session);
      if (!session) throw new HostChatError(409, "Wait until the provider saves this session.");
      target = { folder, provider: provider(session), sessionId: session.sessionId, key: session.key };
      lastMode = run?.mode;
    }
    // The same permission mode the desktop would use: the chat's latest turn,
    // else the default from Agent Sessions → Settings → Sessions.
    target.mode = this.modeFor(target.provider, lastMode);
    const db = this.database!;
    const key = "host-chat:" + requestId;
    const fingerprint = hash(JSON.stringify({ ...input, requestId }));
    const receipt: SendReceipt = {
      fingerprint, runId: randomUUID(), ...(input.action === "start" ? { session: "new-" + requestId } : {}),
    };
    if (!db.reserveAppData(key, receipt)) {
      const existing = db.appData(key) as SendReceipt;
      if (existing.fingerprint !== fingerprint)
        throw new HostChatError(409, "This send ID already belongs to another message.");
      const starting = this.starting.get(key);
      if (starting) return starting;
      if (existing.error) throw new HostChatError(409, existing.error);
      if (!existing.accepted && !this.runner.inspect(existing.runId))
        throw new HostChatError(409, "The host restarted during this send. Check the conversation before sending again.");
      return { runId: existing.runId, session: existing.session };
    }
    const work = this.send(db, key, receipt, target, input.message);
    this.starting.set(key, work);
    try {
      return await work;
    } finally {
      this.starting.delete(key);
    }
  }

  private async send(db: LocalDatabase, key: string, receipt: SendReceipt, target: Parameters<AgentRunner["start"]>[0], message: string) {
    try {
      await this.runner.start(target, message, receipt.runId);
    } catch {
      const run = target.sessionId ? this.runner.current(target) : null;
      receipt.error = agentBusy(run) ? "This session already has a running turn." : "The host could not start the turn. Check Agent Sessions on the desktop.";
      db.saveAppData(key, receipt);
      throw new HostChatError(409, receipt.error);
    }
    receipt.accepted = true;
    db.saveAppData(key, receipt);
    return { runId: receipt.runId, session: receipt.session };
  }

  async close() {
    await Promise.allSettled(this.starting.values());
    this.database?.close();
    this.database = undefined;
  }
}
