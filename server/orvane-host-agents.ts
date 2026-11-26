import type { ServerResponse } from "node:http";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { platform } from "node:os";
import { splitAttachments, type AgentRunSummary } from "../src/agentSessions.ts";
import type { AgentSession } from "../src/exposition.ts";
import type { AgentRunner } from "./agent-runner.ts";
import { createFilesService } from "./files.ts";
import { HostChatError, type HostAgentChat } from "./orvane-host-chat.ts";
import type { SessionTranscripts } from "./session-transcripts.ts";

export type HostReply = (status: number, value: unknown) => void;
/** The desktop's own Agent Sessions operations (agent-sessions-api.ts). */
export type AgentOperate = (
  op: string, args: Record<string, any>, url: URL, res: ServerResponse, reply: HostReply,
) => Promise<void>;
export type HostAgents = ReturnType<typeof hostAgentGateway>;

// Operations the laptop page may call, with the check each needs. Anything
// else (settings, MCP, delegation, schedules, default modes, notes…) is 404.
const free = new Set(["models", "usage", "save-prompt", "delete-prompt", "suggest", "attachment-save", "attachment"]);
const byRun = new Set(["inspect-run", "stop", "queue", "unqueue", "queue-now", "steer", "run-changes", "run-diff", "permission", "run-events"]);
const bySessionKey = new Set(["read", "transcript-file"]);
const bySessionId = new Set(["session-approvals", "checkpoints", "checkpoint-preview", "checkpoint-restore"]);

/**
 * Orvane Host's gateway for the real AgentSessions.vue on a laptop: the same
 * operations as the desktop, limited to the shared project folders.
 */
export function hostAgentGateway(
  chat: HostAgentChat,
  transcripts: Record<"claude" | "codex", Pick<SessionTranscripts, "list" | "find">>,
  runner: Pick<AgentRunner, "inspect">,
  operate: AgentOperate,
  dataDirectory: string,
  attachments: string,
) {
  const files = createFilesService(dataDirectory);
  const denied = () => new HostChatError(404, "That item is not shared with this host.");
  const within = async (path: unknown) => {
    if (typeof path !== "string" || !(await chat.allowedFolder(path))) throw denied();
  };
  const sessionByKey = async (key: unknown) => {
    if (typeof key !== "string") throw denied();
    const session = await (key.startsWith("codex:") ? transcripts.codex : transcripts.claude).find(key);
    await within(session.project);
  };
  const sessionById = async (args: Record<string, any>) => {
    const lists = await Promise.all([transcripts.claude.list(), transcripts.codex.list()]);
    const session = lists.flat().find((item) => item.sessionId === args.sessionId &&
      (item.provider ?? "claude") === (args.provider ?? "claude") &&
      (item.provider === "codex" || (item.profileId ?? "default") === (args.profileId ?? "default")));
    if (!session) throw denied();
    await within(session.project);
  };
  const runById = async (id: unknown) => {
    const run = typeof id === "string" ? runner.inspect(id) : null;
    // Unknown runs pass through: the desktop handler answers them as it does.
    if (run) await within(run.folder);
  };
  const pictures = realpath(attachments).catch(() => attachments);
  // Attachments the laptop names must be pasted pictures or shared files.
  const attachmentsAllowed = async (message: unknown) => {
    if (typeof message !== "string") return;
    const folder = await pictures;
    for (const path of splitAttachments(message).paths) {
      const real = await realpath(path).catch(() => path);
      const fromPictures = relative(folder, real);
      if (fromPictures && !fromPictures.startsWith("..") && !isAbsolute(fromPictures)) continue;
      await within(path);
    }
  };
  const visible = async <T>(items: T[], folder: (item: T) => string) => {
    const allowed = new Map<string, boolean>();
    const kept: T[] = [];
    for (const item of items) {
      const path = folder(item);
      if (!allowed.has(path)) allowed.set(path, !!(await chat.allowedFolder(path)));
      if (allowed.get(path)) kept.push(item);
    }
    return kept;
  };

  return {
    approvals: chat.approvals,
    async agents(op: string, args: Record<string, any>, url: URL, res: ServerResponse, reply: HostReply) {
      if (op === "claude-profiles") {
        // The shared desktop view needs account names/availability. Keep local
        // configuration paths and account-management capabilities on desktop.
        return operate(op, {}, url, res, (status, value) => {
          if (status !== 200) return reply(status, value);
          const data = value as { profiles?: Record<string, unknown>[]; newChatProfileId?: string };
          reply(200, { newChatProfileId: data.newChatProfileId, draft: null,
            profiles: (data.profiles ?? []).map((profile) => ({ ...profile, folder: "", sessions: 0, running: 0, mcp: false })) });
        });
      }
      if (op === "sessions" || op === "runs") {
        // Only the shared projects' sessions and runs reach the laptop.
        let listed: { sessions?: AgentSession[]; runs?: AgentRunSummary[] } | undefined;
        let status = 200;
        await operate(op, args, url, res, (code, value) => { status = code; listed = value as typeof listed; });
        if (status !== 200 || !listed) return reply(status, listed);
        return reply(200, {
          ...listed,
          ...(listed.sessions ? { sessions: await visible(listed.sessions, (item) => item.project) } : {}),
          ...(listed.runs ? { runs: await visible(listed.runs, (item) => item.folder) } : {}),
        });
      }
      if (op === "start") {
        const target = args.target as { key?: unknown; folder?: unknown } | undefined;
        if (target && "key" in target) await sessionByKey(target.key);
        // A new session needs a shared folder: no default Surveying folder.
        else await within(target?.folder);
        await attachmentsAllowed(args.message);
      } else if (op === "slash") {
        if (args.folder !== undefined) await within(args.folder);
      } else if (byRun.has(op)) {
        if (op === "permission" && !chat.approvals)
          throw new HostChatError(403, "Answer this request on the desktop.");
        await runById(op === "run-events" ? url.searchParams.get("id") : args.id);
        if (op === "queue") await attachmentsAllowed(args.message);
      } else if (op === "picture") {
        // A picture in a reply: only from shared folders or pasted pictures.
        const path = url.searchParams.get("path") ?? "";
        const real = isAbsolute(path) ? await realpath(path).catch(() => "") : "";
        const fromPictures = real ? relative(await pictures, real) : "..";
        if (!real || fromPictures.startsWith("..") || isAbsolute(fromPictures)) await within(path);
      } else if (bySessionKey.has(op)) await sessionByKey(args.key);
      else if (bySessionId.has(op)) await sessionById(args);
      else if (!free.has(op)) throw new HostChatError(404, "This action is only available on the desktop.");
      await operate(op, args, url, res, reply);
    },
    /** File Explorer reads for the folder browser and @ picker, in shared folders only. */
    async files(op: string, args: Record<string, unknown>) {
      if (op === "roots") {
        const roots = await chat.sharedRoots();
        return {
          token: "", home: roots[0], separator: sep, platform: platform(), drives: [],
          places: roots.map((path) => ({ name: basename(path) || path, path, icon: "folder" })),
        };
      }
      if (op !== "list" && op !== "search") throw new HostChatError(404, "This action is only available on the desktop.");
      if ("paths" in args) throw denied();
      await within(args.path);
      const data = await files.invoke(op, args) as { entries: { path: string }[] };
      const roots = await chat.sharedRoots();
      // Search follows folders by name; drop anything that left the shared roots.
      return {
        ...data,
        entries: data.entries.filter(({ path }) => roots.some((root) => {
          const fromRoot = relative(root, path);
          return !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
        })),
      };
    },
  };
}

