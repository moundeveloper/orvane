// Claude transcripts across accounts: one read-only SessionTranscripts per
// account root. Default keeps its legacy unprefixed keys (so saved visuals
// and pane state stay valid); other accounts use `claude@<id>:…`, so the same
// session UUID in two roots never collides.
import { resolve } from "node:path";
import { SessionTranscripts, visualShowSchema, visualTargetSchema, visualUpdateSchema } from "./session-transcripts.ts";
import { DEFAULT_PROFILE, profileIdPattern, realOrAncestor } from "./claude-profiles.ts";

export interface TranscriptRoot {
  id: string;
  /** The account's transcript folder. */
  root: string;
  /** The account's config folder, for SessionStart bindings. */
  configDir: string;
}

const win = process.platform === "win32";
const fold = (path: string) => (win ? resolve(path).toLowerCase() : resolve(path));

/** The account a Claude key belongs to: unprefixed keys are Default's. */
export function profileOfKey(key: string): string | undefined {
  if (key.startsWith("codex:")) return undefined;
  const match = /^claude@([a-z0-9][a-z0-9-]{2,39}):/.exec(key);
  if (match) return match[1]!;
  return key.startsWith("claude@") ? "" : DEFAULT_PROFILE;
}

export class ClaudeTranscriptSet {
  private roots = new Map<string, { root: string; configDir: string; transcripts: SessionTranscripts }>();
  constructor(
    private directory: string,
    private list: () => TranscriptRoot[],
  ) {}
  /** Sync with the account list (new accounts get a root; roots never move). */
  private sync() {
    for (const item of this.list()) {
      if (item.id !== DEFAULT_PROFILE && !profileIdPattern.test(item.id)) continue;
      const known = this.roots.get(item.id);
      if (known && fold(known.root) === fold(item.root)) {
        known.configDir = item.configDir;
        continue;
      }
      known?.transcripts.close();
      this.roots.set(item.id, {
        root: item.root,
        configDir: item.configDir,
        transcripts: new SessionTranscripts(this.directory, item.root, undefined, "claude", item.id),
      });
    }
    return this.roots;
  }
  /** The transcripts of one account. */
  of(profileId: string) {
    const entry = this.sync().get(profileId);
    if (!entry) throw Error("That Claude account was not found.");
    return entry.transcripts;
  }
  forKey(key: string) {
    const id = profileOfKey(key);
    if (!id) throw Error("Session not found. Refresh the session list.");
    return this.of(id);
  }
  async all() {
    const lists = await Promise.all([...this.sync().values()].map(({ transcripts }) => transcripts.list().catch(() => [])));
    return lists.flat();
  }
  invalidate() {
    for (const { transcripts } of this.roots.values()) transcripts.invalidate();
  }
  /**
   * The trusted transcript path to resume a session of one account: only that
   * account's root is searched; missing or out-of-root files fail closed.
   */
  async resumePath(profileId: string, sessionId: string, name: string, key?: string) {
    const transcripts = this.of(profileId);
    transcripts.invalidate();
    if (key) {
      if (profileOfKey(key) !== profileId) throw Error("The selected transcript belongs to another Claude account.");
      const selected = await transcripts.find(key);
      if (selected.sessionId.toLowerCase() !== sessionId.toLowerCase())
        throw Error("The selected transcript doesn't match this session.");
      return transcripts.file(key);
    }
    const matches = (await transcripts.list()).filter((s) => s.sessionId.toLowerCase() === sessionId.toLowerCase());
    if (matches.length > 1) throw Error("Several transcripts have this session ID. Open the exact chat before resuming it.");
    const session = matches[0];
    if (!session)
      throw Error(`This chat's transcript was not found in the folder of the account ${name}. Orvane won't resume it from anywhere else.`);
    return transcripts.file(session.key);
  }
  /** Exposition: the one account root holding this session binding. */
  async target(raw: unknown) {
    const args = visualTargetSchema.parse(raw);
    const wanted = args.configDir ? fold(await realOrAncestor(args.configDir).catch(() => args.configDir!)) : undefined;
    const matches: SessionTranscripts[] = [];
    for (const [, entry] of this.sync()) {
      if (wanted) {
        const own = fold(await realOrAncestor(entry.configDir).catch(() => entry.configDir));
        if (own !== wanted) continue;
      }
      const found = (await entry.transcripts.list()).some(
        (s) => s.sessionId === args.sessionId && fold(s.project) === fold(args.projectPath),
      );
      if (found) matches.push(entry.transcripts);
    }
    if (matches.length !== 1)
      throw Error(
        matches.length
          ? "Several Claude accounts have this session. Use the exact binding (with its configDir) from the Orvane session context."
          : "Provide the exact Claude session ID and project path from the Orvane session context. Never guess the most recent session.",
      );
    return matches[0]!;
  }
  async show(raw: unknown) {
    visualShowSchema.parse(raw);
    return (await this.target(raw)).show(raw);
  }
  async update(raw: unknown) {
    visualUpdateSchema.parse(raw);
    return (await this.target(raw)).update(raw);
  }
  async visualsFor(raw: unknown) {
    const transcripts = await this.target(raw);
    const args = visualTargetSchema.parse(raw);
    const session = (await transcripts.list()).find(
      (s) => s.sessionId === args.sessionId && fold(s.project) === fold(args.projectPath),
    )!;
    return transcripts.visuals(session.key);
  }
  close() {
    for (const { transcripts } of this.roots.values()) transcripts.close();
    this.roots.clear();
  }
}
