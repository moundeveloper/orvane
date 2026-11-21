// What "/" offers in the Agent sessions composer: the agent's skills (from
// its skills folders), the session commands that work in a headless run,
// and the owner's saved prompts. Saved prompts live in app_data
// "saved-prompts" of workspace.sqlite, so backups include them and every
// connected AI can read them.
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { LocalDatabase } from "./database.ts";
import type { AgentProvider } from "../src/agentSessions.ts";

export interface SlashItem {
  kind: "skill" | "command" | "prompt";
  name: string;
  description: string;
  /** Text a saved prompt inserts. */
  text?: string;
}

const commands: Record<AgentProvider, SlashItem[]> = {
  claude: [
    { kind: "command", name: "compact", description: "Summarize the conversation to save context" },
  ],
  codex: [],
};

/** name and description from a SKILL.md front matter block. */
export function skillFrontMatter(text: string) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!block) return null;
  const fields: Record<string, string> = {};
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([\w-]+):\s*(.*)$/.exec(lines[i]!);
    if (!match) continue;
    let value = match[2]!.trim();
    // Folded and literal blocks continue on the indented lines below.
    if (/^[>|][-+]?$/.test(value)) {
      const rest: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]!)) rest.push(lines[++i]!.trim());
      value = rest.join(" ").trim();
    }
    fields[match[1]!] = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return fields.name ? { name: fields.name, description: fields.description ?? "" } : null;
}

async function skillsIn(folder: string) {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .slice(0, 300)
      .map(async (entry) => {
        const text = await readFile(join(folder, entry.name, "SKILL.md"), "utf8").catch(() => "");
        const meta = text && skillFrontMatter(text.slice(0, 8000));
        return meta && /^[\w:.-]{1,80}$/.test(meta.name) ? meta : null;
      }),
  );
  return found.filter((item) => item !== null);
}

/** Skills the agent loads: the user's own folder, then the project's. */
export async function listSkills(provider: AgentProvider, userFolder: string, project?: string) {
  const dot = provider === "claude" ? ".claude" : ".codex";
  const folders = [userFolder, ...(project ? [join(project, dot, "skills")] : [])];
  const seen = new Set<string>();
  const skills: SlashItem[] = [];
  for (const folder of folders)
    for (const skill of await skillsIn(folder))
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        skills.push({ kind: "skill", name: skill.name, description: skill.description.slice(0, 200) });
      }
  return [...skills.sort((a, b) => a.name.localeCompare(b.name)), ...commands[provider]];
}

export interface SavedPrompt {
  name: string;
  text: string;
  updatedAt: number;
}
const KEY = "saved-prompts";
const LIMIT = 100;
export const PROMPT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export class SavedPrompts {
  private db?: LocalDatabase;
  constructor(private file: string) {}
  private database() {
    return (this.db ||= new LocalDatabase(this.file));
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
  list(): SavedPrompt[] {
    const saved = this.database().appData(KEY) as { prompts?: SavedPrompt[] } | undefined;
    return saved?.prompts ?? [];
  }
  save(name: string, text: string) {
    if (!PROMPT_NAME.test(name))
      throw Error("A prompt name is 1-40 lowercase letters, numbers or dashes.");
    const body = text.trim();
    if (!body) throw Error("The prompt is empty.");
    if (body.length > 8000) throw Error("The prompt is too long (at most 8000 characters).");
    const prompts = this.list().filter((prompt) => prompt.name !== name);
    if (prompts.length >= LIMIT) throw Error(`Orvane keeps at most ${LIMIT} saved prompts.`);
    prompts.push({ name, text: body, updatedAt: Date.now() });
    prompts.sort((a, b) => a.name.localeCompare(b.name));
    this.database().saveAppData(KEY, { prompts });
    return prompts;
  }
  remove(name: string) {
    const prompts = this.list().filter((prompt) => prompt.name !== name);
    this.database().saveAppData(KEY, { prompts });
    return prompts;
  }
}
