import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentBusy, agentEditModes, type AgentEditMode, type AgentProvider, type AgentRun } from "../src/agentSessions.ts";
import type { AgentDelegationInput } from "../src/agentDelegation.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { LocalDatabase } from "./database.ts";
import { defaultModesKey } from "./orvane-host-chat.ts";

type Receipt = {
  fingerprint: string;
  delegationId: string;
  sourceSessionKey?: string;
  provider: AgentRun["provider"];
  folder: string;
  model?: string;
  effort?: AgentRun["effort"];
  mode: AgentEditMode;
  error?: string;
};

const receiptKey = (id: string) => `agent-delegation:${id}`;

export class AgentDelegations {
  private db?: LocalDatabase;
  private starting = new Set<string>();

  constructor(
    private file: string,
    private directory: string,
    private runner: AgentRunner,
    private sessionKey: (provider: AgentRun["provider"], id: string) => Promise<string | undefined>,
    private bindTarget: (target: Parameters<AgentRunner["start"]>[0]) => Parameters<AgentRunner["start"]>[0] = (target) => target,
  ) {}

  private database() {
    return (this.db ??= new LocalDatabase(this.file));
  }

  private receipt(id: string) {
    return this.database().appData(receiptKey(id)) as Receipt | undefined;
  }

  private async run(id: string) {
    const live = this.runner.inspect(id);
    if (live) return live;
    const saved = await readFile(join(this.directory, "agent-runs", id + ".json"), "utf8")
      .then((text) => JSON.parse(text) as AgentRun)
      .catch(() => undefined);
    return saved?.id === id ? saved : undefined;
  }

  private async describe(id: string, receipt: Receipt) {
    const run = await this.run(id);
    const sessionId = run?.sessionId;
    return {
      runId: id,
      delegationId: receipt.delegationId,
      sourceSessionKey: receipt.sourceSessionKey,
      provider: receipt.provider,
      model: receipt.model,
      folder: run?.folder ?? receipt.folder,
      status: run?.status ?? (receipt.error ? "failed" : this.starting.has(id) ? "starting" : "interrupted"),
      sessionId,
      sessionKey: run?.key ?? (sessionId ? await this.sessionKey(receipt.provider, sessionId).catch(() => undefined) : undefined),
      activity: run?.activity || undefined,
      awaitingApproval: !!run?.permissions.length,
      result: run?.text ? run.text.slice(0, 24_000) : undefined,
      resultTruncated: (run?.text.length ?? 0) > 24_000,
      error: run?.error ?? receipt.error,
    };
  }

  async execute(input: AgentDelegationInput) {
    if (input.action === "status" || input.action === "stop") {
      const runId = input.runId.toLowerCase();
      const receipt = this.receipt(runId);
      if (!receipt) throw Error("Delegated run was not found.");
      if (input.action === "stop") {
        if (this.starting.has(runId) && !this.runner.inspect(runId))
          throw Error("The delegated run is starting. Check its status before stopping it.");
        this.runner.stop(runId);
      }
      return this.describe(runId, receipt);
    }

    const requestId = input.requestId.toLowerCase();
    const parentRunId = input.action === "follow_up" ? input.runId.toLowerCase() : undefined;
    const normalized = { ...input, requestId, runId: parentRunId };
    const fingerprint = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const previous = this.receipt(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw Error("This request ID was already used with different arguments.");
      return this.describe(requestId, previous);
    }

    let receipt: Receipt;
    let sessionId: string | undefined;
    let key: string | undefined;
    if (input.action === "start") {
      const { provider, folder, model, effort, sourceSessionKey } = input;
      const defaults = this.database().appData(defaultModesKey) as Partial<Record<AgentProvider, AgentEditMode>> | undefined;
      const savedMode = defaults?.[provider];
      const supportedModes = agentEditModes[provider];
      const mode = input.mode ?? (savedMode && supportedModes.includes(savedMode) ? savedMode : supportedModes[0]!);
      if (provider === "codex" && mode === "ask")
        throw Error("Codex delegation supports Auto-accept, Plan only, or Full access.");
      receipt = { fingerprint, delegationId: requestId, provider, folder, model, effort, mode, sourceSessionKey };
    } else {
      const parent = this.receipt(input.runId.toLowerCase());
      if (!parent) throw Error("Delegated run was not found.");
      const run = await this.run(input.runId.toLowerCase());
      if (!run?.sessionId || agentBusy(run))
        throw Error("Wait for the delegated turn to finish and have a session ID.");
      sessionId = run.sessionId;
      key = run.key ?? await this.sessionKey(parent.provider, sessionId).catch(() => undefined);
      const { error: _error, ...target } = parent;
      receipt = { ...target, fingerprint, folder: run.folder };
    }

    // Reserve before launching. A replay after a timeout or restart observes
    // the same turn. Only a new request ID can start another turn.
    if (!this.database().reserveAppData(receiptKey(requestId), receipt)) {
      const concurrent = this.receipt(requestId)!;
      if (concurrent.fingerprint !== fingerprint)
        throw Error("This request ID was already used with different arguments.");
      return this.describe(requestId, concurrent);
    }
    this.starting.add(requestId);
    try {
      await this.runner.start(this.bindTarget({
        provider: receipt.provider,
        folder: receipt.folder,
        model: receipt.model,
        effort: receipt.effort,
        mode: receipt.mode,
        key,
        sessionId,
        delegationId: receipt.delegationId,
      }), input.message, requestId);
    } catch (error) {
      receipt.error = error instanceof Error ? error.message : String(error);
      this.database().saveAppData(receiptKey(requestId), receipt);
    } finally {
      this.starting.delete(requestId);
    }
    return this.describe(requestId, receipt);
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }
}
