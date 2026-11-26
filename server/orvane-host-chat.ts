import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { agentEditModes, type AgentEditMode, type AgentProvider } from "../src/agentSessions.ts";
import { LocalDatabase } from "./database.ts";

export const hostProjectList = z.array(z.string().min(1).max(2000)).min(1).max(32);
/** App data key for the desktop's default edit mode per CLI. */
export const defaultModesKey = "agent-default-modes";
export class HostChatError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * What Host access shares of Agent Sessions: the chosen project folders,
 * whether approvals may be answered from the laptop, and the desktop's
 * default edit modes. The laptop page itself is the desktop component.
 */
export class HostAgentChat {
  private roots: Promise<string[]>;

  constructor(
    projects: string[],
    private databaseFile: string,
    readonly approvals = false,
  ) {
    this.roots = Promise.all(hostProjectList.parse(projects).map(async (path) => {
      if (!isAbsolute(path)) throw Error("Host projects must use absolute paths.");
      const folder = await realpath(path);
      if (!(await stat(folder)).isDirectory()) throw Error("Host projects must be directories.");
      return folder;
    }));
  }

  async ready() { await this.roots; }

  /** The shared project folders, resolved. */
  sharedRoots() { return this.roots; }

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

  /** Agent Sessions → Settings → Sessions default edit modes, as the desktop saved them. */
  defaultModes() {
    const db = new LocalDatabase(this.databaseFile);
    try {
      const saved = (db.appData(defaultModesKey) ?? {}) as Partial<Record<AgentProvider, AgentEditMode>>;
      return Object.fromEntries((["claude", "codex"] as const)
        .filter((kind) => saved[kind] && agentEditModes[kind].includes(saved[kind]!))
        .map((kind) => [kind, saved[kind]])) as Partial<Record<AgentProvider, AgentEditMode>>;
    } finally {
      db.close();
    }
  }

  async close() {}
}
