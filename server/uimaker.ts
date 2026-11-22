// UI Maker: you draw the brief on a live component (sketches, pinned notes,
// reference boards, exact CSS values); an agent reads it through the Orvane
// MCP server and delivers the next iteration as v<n+1>/index.html.
//
// Storage: the editor state and activity feed live in the shared SQLite file
// (app_data keys "uimaker:state" and "uimaker:feed"). Iterations, briefs and
// reference images are files under <data dir>/uimaker/, so the agent can read
// them directly and the editor can load them in an iframe.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { LocalDatabase } from "./database.ts";

type Pt = [number, number];
type Rect = { x: number; y: number; w: number; h: number };
type Target = { selector: string; tag: string; text: string; rect: Rect } | null;
interface Ref { id: string; file: string; caption?: string; bx: number; by: number; bw: number; ar?: number }
interface BoardStroke { id: string; tool: string; color: string; size: number; pts: Pt[]; ref?: string | null }
interface BoardPin { id: string; ref?: string | null; u: number; v: number; text: string; color: string }
interface Board { refs?: Ref[]; bstrokes?: BoardStroke[]; bpins?: BoardPin[] }
export interface Component extends Board {
  id: string;
  name: string;
  width: number;
  height: number | null;
  intent?: string;
  target?: string | null;
  match?: { v: number; pct: number } | null;
}
export interface Note extends Board {
  id: string; c: string; v: number; title: string; text: string; color: string;
  x: number; y: number; lx: number; ly: number; target: Target; elementPin?: boolean;
}
interface Stroke { id: string; c: string; v: number; tool: string; color: string; size: number; pts: Pt[]; note: string | null; target: Target }
interface Tweak { id: string; c: string; v: number; selector: string; prop: string; value: string; from?: string }
export interface UiState { name?: string; components: Component[]; notes: Note[]; strokes: Stroke[]; tweaks: Tweak[] }
export interface Version { n: number; mtime: number; response: { summary?: string; notes?: Record<string, string>; lab?: { round: string; variant: string } } | null }
export type LabKind = "redesign" | "new";
/** about: the agent's plain explanation of the variant, shown in the Lab under the tabs. */
export interface LabVariant { id: string; label: string; at: number; about?: string; mtime?: number }
export interface LabRound {
  id: string; title: string; kind: LabKind; base: number | null;
  status: "open" | "picked" | "closed"; picked?: string; pickedAs?: number; at: number; variants: LabVariant[];
}
export interface LabEdit { find: string; replace: string; all?: boolean }
export interface FeedItem { id: string; at: number; kind: string; c?: string; text: string }
export interface BriefImage { file: string; path: string; label: string }

const STATE_KEY = "uimaker:state",
  FEED_KEY = "uimaker:feed";
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".woff2": "font/woff2",
};
export const IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
};
const MEANING: Record<string, string> = {
  "#ff5a5f": "RED — wrong / remove / do not like this",
  "#4ade80": "GREEN — add this / this is what I want",
  "#f5b942": "AMBER — look here, needs attention",
  "#78b4ff": "BLUE — layout / structure sketch",
  "#6cb6ff": "BLUE — layout / structure sketch",
  "#455968": "SLATE — free sketch",
  "#ffffff": "WHITE — free sketch",
};
const KIND: Record<string, string> = { "#ff5a5f": "FIX", "#4ade80": "ADD", "#f5b942": "QUESTION", "#78b4ff": "LAYOUT", "#6cb6ff": "LAYOUT" };
const BLANK = `<!doctype html>
<html><head><meta charset="utf-8"><title>Blank</title>
<style>html,body{margin:0;background:#ffffff;min-height:360px;font-family:Inter,system-ui,sans-serif}</style>
</head><body></body></html>
`;
const shotPage = fileURLToPath(new URL("./uimaker-shot.html", import.meta.url));
const overlayScript = fileURLToPath(new URL("../src/components/uimaker/overlay.js", import.meta.url));

const uid = () => Math.random().toString(36).slice(2, 9);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "component";
const unix = (p: string) => p.split(path.sep).join("/");
const bbox = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return `x ${Math.round(x)}, y ${Math.round(y)}, ${Math.round(Math.max(...xs) - x)}×${Math.round(Math.max(...ys) - y)}px`;
};
const tgt = (t: Target) =>
  t ? `\`${t.selector}\` — <${t.tag}>${t.text ? ` "${t.text}"` : ""} at ${t.rect.x},${t.rect.y} ${t.rect.w}×${t.rect.h}` : "outside the component";
function findBrowser() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return process.env.ORVANE_UIMAKER_BROWSER || candidates.find((p) => fs.existsSync(p));
}
function checkState(value: unknown): asserts value is UiState {
  const s = value as Partial<UiState> | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.components) || !Array.isArray(s.notes) || !Array.isArray(s.strokes) || !Array.isArray(s.tweaks))
    throw Error("UI Maker state needs components, notes, strokes and tweaks lists.");
  for (const c of s.components) if (!ID.test(c?.id ?? "")) throw Error("Invalid component ID.");
}

type Browser = { newPage(options: object): Promise<Page>; close(): Promise<void>; on(event: "disconnected", fn: () => void): void };
type Page = {
  goto(url: string, options: object): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, options?: object): Promise<unknown>;
  $(selector: string): Promise<{ screenshot(options: object): Promise<Buffer> } | null>;
  close(): Promise<void>;
};

export class UiMakerService {
  readonly root: string;
  readonly components: string;
  readonly refs: string;
  private db?: LocalDatabase;
  private browser?: Promise<Browser>;
  private render?: Promise<{ server: Server; base: string }>;
  private renderStates = new Map<string, UiState>();
  constructor(
    private directory: string,
    private filename = "workspace.sqlite",
  ) {
    this.root = path.join(directory, filename === "workspace.sqlite" ? "uimaker" : `uimaker-${path.basename(filename, ".sqlite")}`);
    this.components = path.join(this.root, "components");
    this.refs = path.join(this.root, "refs");
  }
  private database() {
    return (this.db ??= new LocalDatabase(path.join(this.directory, this.filename)));
  }

  // ---------- state + feed ----------
  readState(): UiState {
    const state = this.database().appData(STATE_KEY) as UiState | undefined;
    return state ?? { name: "UI Maker", components: [], notes: [], strokes: [], tweaks: [] };
  }
  saveState(state: unknown) {
    checkState(state);
    this.database().saveAppData(STATE_KEY, state);
  }
  readFeed(): FeedItem[] {
    return (this.database().appData(FEED_KEY) as FeedItem[] | undefined) ?? [];
  }
  addFeed(kind: string, c: string | undefined, text: string) {
    const item = { id: uid(), at: Date.now(), kind, c, text: String(text).slice(0, 700) };
    this.database().saveAppData(FEED_KEY, [...this.readFeed(), item].slice(-200));
    return item;
  }

  // ---------- files ----------
  component(id: string) {
    if (!ID.test(id)) throw Error("Invalid component ID.");
    const c = this.readState().components.find((x) => x.id === id);
    if (!c) throw Error(`Unknown UI Maker component "${id}". Call uimaker_list for the IDs.`);
    return c;
  }
  async versions(id: string): Promise<Version[]> {
    const dir = path.join(this.components, id);
    const out: Version[] = [];
    for (const d of await fsp.readdir(dir).catch(() => [] as string[])) {
      const m = /^v(\d+)$/.exec(d);
      const file = path.join(dir, d, "index.html");
      if (!m || !fs.existsSync(file)) continue;
      let response = null;
      try { response = JSON.parse(await fsp.readFile(path.join(dir, d, "response.json"), "utf8")); } catch {}
      out.push({ n: Number(m[1]), mtime: fs.statSync(file).mtimeMs, response });
    }
    return out.sort((a, b) => a.n - b.n);
  }
  async allVersions() {
    const out: Record<string, Version[]> = {};
    for (const c of this.readState().components) out[c.id] = await this.versions(c.id);
    return out;
  }
  async snapshot() {
    return { state: this.readState(), versions: await this.allVersions(), feed: this.readFeed(), lab: await this.allLab() };
  }
  /** Creates v1 for a new component; the editor adds it to its state. */
  async createFolder(name: string) {
    let id = slug(name);
    while (fs.existsSync(path.join(this.components, id))) id = `${id}-${uid().slice(0, 3)}`;
    await fsp.mkdir(path.join(this.components, id, "v1"), { recursive: true });
    await fsp.writeFile(path.join(this.components, id, "v1", "index.html"), BLANK);
    return { id };
  }
  /** Creates a component the way the editor's New button does: a blank v1 and
   * an entry in the saved state, which open editors adopt on the next change. */
  async create(input: { name: string; intent?: string; width?: number; height?: number | null }) {
    const name = input.name.trim();
    if (!name) throw Error("Give the component a name.");
    const width = input.width ?? 480, height = input.height === undefined ? 360 : input.height;
    if (!Number.isInteger(width) || width < 40 || width > 3000) throw Error("Width must be a whole number from 40 to 3000.");
    if (height !== null && (!Number.isInteger(height) || height < 20 || height > 6000))
      throw Error("Height must be a whole number from 20 to 6000, or auto.");
    const { id } = await this.createFolder(name);
    const state = this.readState();
    state.components.push({ id, name, width, height, intent: input.intent ?? "", refs: [], bstrokes: [], bpins: [], target: null, match: null });
    this.saveState(state);
    // Touch the folder so open editors pull the new state.
    await fsp.writeFile(path.join(this.components, id, "artboard.json"), JSON.stringify({ width, height, at: Date.now() }));
    this.addFeed("create", id, `Created ${name}`);
    return { id, name, width, height };
  }
  async saveRef(type: string, data: Buffer) {
    const ext = IMAGE_TYPES[type];
    if (!ext) throw Error("Only PNG, JPEG, WebP and GIF images can be references.");
    if (data.length > 25_000_000) throw Error("Reference images are limited to 25 MB.");
    await fsp.mkdir(this.refs, { recursive: true });
    const file = uid() + uid() + ext;
    await fsp.writeFile(path.join(this.refs, file), data);
    return { file };
  }
  /** A file inside components/ or refs/, or undefined when the path leaves them. */
  resolve(area: "c" | "refs", rel: string) {
    const base = area === "c" ? this.components : this.refs;
    const file = path.resolve(base, rel);
    return file.startsWith(base + path.sep) ? file : undefined;
  }
  mime(file: string) {
    return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  }
  async readVersion(id: string, v?: number) {
    this.component(id);
    const vs = await this.versions(id);
    const n = v ?? vs.at(-1)?.n;
    if (!n || !vs.some((x) => x.n === n)) throw Error(`Component "${id}" has no v${v}.`);
    const file = path.join(this.components, id, `v${n}`, "index.html");
    return { v: n, path: unix(file), html: await fsp.readFile(file, "utf8") };
  }
  /** Writes the next iteration. Never overwrites an existing version. */
  async deliver(id: string, html: string, summary: string, notes: Record<string, string> = {}, lab?: { round: string; variant: string }) {
    this.component(id);
    if (!html.trim()) throw Error("The iteration HTML is empty.");
    const next = Math.max(0, ...(await this.versions(id)).map((x) => x.n)) + 1;
    const dir = path.join(this.components, id, `v${next}`);
    await fsp.mkdir(dir); // fails if a concurrent delivery already took this number
    // response.json first: the editor switches versions when index.html appears.
    await fsp.writeFile(path.join(dir, "response.json"), JSON.stringify(lab ? { summary, notes, lab } : { summary, notes }, null, 2) + "\n");
    await fsp.writeFile(path.join(dir, "index.html"), html);
    this.addFeed("iteration", id, `v${next} delivered${summary ? " — " + summary : ""}`);
    return { v: next, path: unix(path.join(dir, "index.html")) };
  }
  // ---------- lab: rounds of side-by-side variants ----------
  // components/<c>/lab/<round>/round.json lists the round and its variants;
  // each variant is one self-contained page, <variant>.html, next to it.
  // A round is "open" while it is being worked on; picking a variant writes
  // it as the component's next iteration and closes the round.
  private labDir(c: string, round?: string) {
    const dir = path.join(this.components, c, "lab");
    if (round === undefined) return dir;
    if (!ID.test(round)) throw Error("Invalid lab round ID.");
    return path.join(dir, round);
  }
  async labRounds(c: string): Promise<LabRound[]> {
    const out: LabRound[] = [];
    for (const d of await fsp.readdir(this.labDir(c)).catch(() => [] as string[])) {
      let round: LabRound;
      try { round = JSON.parse(await fsp.readFile(path.join(this.labDir(c), d, "round.json"), "utf8")); } catch { continue; }
      for (const v of round.variants) {
        v.mtime = (await fsp.stat(path.join(this.labDir(c), d, `${v.id}.html`)).catch(() => undefined))?.mtimeMs ?? 0;
      }
      out.push(round);
    }
    return out.sort((a, b) => b.at - a.at);
  }
  async allLab() {
    const out: Record<string, LabRound[]> = {};
    for (const c of this.readState().components) {
      const rounds = await this.labRounds(c.id);
      if (rounds.length) out[c.id] = rounds;
    }
    return out;
  }
  private async saveRound(c: string, round: LabRound) {
    const clean = { ...round, variants: round.variants.map(({ mtime: _m, ...v }) => v) };
    await fsp.writeFile(path.join(this.labDir(c, round.id), "round.json"), JSON.stringify(clean, null, 2) + "\n");
  }
  /** The named round, or the open one when no ID is given. */
  async labRound(c: string, id?: string) {
    this.component(c);
    const rounds = await this.labRounds(c);
    const round = id ? rounds.find((r) => r.id === id) : rounds.find((r) => r.status === "open");
    if (!round) throw Error(id ? `Component "${c}" has no lab round "${id}".` : `Component "${c}" has no open lab round. Start one with uimaker_lab_round.`);
    return round;
  }
  /** Starts a new round and makes it the open one; an earlier open round is closed. */
  async labStart(c: string, title: string, kind: LabKind) {
    this.component(c);
    title = title.trim().slice(0, 60);
    if (!title) throw Error("A lab round needs a title.");
    const rounds = await this.labRounds(c);
    for (const r of rounds.filter((r) => r.status === "open")) await this.saveRound(c, { ...r, status: "closed" });
    const n = Math.max(0, ...rounds.map((r) => Number(/^r(\d+)$/.exec(r.id)?.[1] ?? 0))) + 1;
    const latest = (await this.versions(c)).at(-1)?.n ?? null;
    const round: LabRound = { id: `r${n}`, title, kind, base: latest, status: "open", at: Date.now(), variants: [] };
    await fsp.mkdir(this.labDir(c, round.id), { recursive: true });
    await this.saveRound(c, round);
    this.addFeed("lab", c, `Lab round started: ${title}`);
    return round;
  }
  async labRead(c: string, variant: string, roundId?: string) {
    const round = await this.labRound(c, roundId);
    if (!round.variants.some((v) => v.id === variant)) throw Error(`Round "${round.id}" has no variant "${variant}".`);
    const file = path.join(this.labDir(c, round.id), `${variant}.html`);
    return { round, path: unix(file), html: await fsp.readFile(file, "utf8") };
  }
  /** Writes a variant: whole HTML, or exact find/replace edits applied to an
   * existing variant (`from`, default the variant itself). Returns its size. */
  async labWrite(c: string, input: {
    variant: string; label?: string; about?: string; round?: string; html?: string; from?: string; edits?: LabEdit[];
  }) {
    const round = await this.labRound(c, input.round);
    if (round.status !== "open") throw Error(`Round "${round.id}" is ${round.status}; start a new round to add variants.`);
    if (!ID.test(input.variant)) throw Error("Variant IDs use lowercase letters, digits and dashes.");
    const existing = round.variants.find((v) => v.id === input.variant);
    let html = input.html;
    if (html === undefined) {
      const source = input.from ?? (existing ? input.variant : undefined);
      if (!source) throw Error("Give html, or edits with `from` (a variant to start from).");
      html = (await this.labRead(c, source, round.id)).html;
    }
    for (const [i, edit] of (input.edits ?? []).entries()) {
      const count = html.split(edit.find).length - 1;
      if (!edit.find || count === 0) throw Error(`Edit ${i + 1}: the text to find is not in the page.`);
      if (count > 1 && !edit.all) throw Error(`Edit ${i + 1}: the text to find occurs ${count} times; make it unique or set all.`);
      html = edit.all ? html.split(edit.find).join(edit.replace) : html.replace(edit.find, () => edit.replace);
    }
    if (!html.trim()) throw Error("The variant HTML is empty.");
    const label = (input.label ?? existing?.label ?? input.variant).trim().slice(0, 24);
    await fsp.writeFile(path.join(this.labDir(c, round.id), `${input.variant}.html`), html);
    const about = input.about === undefined ? existing?.about : input.about.trim().slice(0, 2000) || undefined;
    if (existing) {
      existing.label = label;
      if (about) existing.about = about;
      else delete existing.about;
    } else round.variants.push({ id: input.variant, label, at: Date.now(), ...(about ? { about } : {}) });
    await this.saveRound(c, round);
    return { round: round.id, variant: input.variant, label, bytes: Buffer.byteLength(html) };
  }
  /** PNG of a lab variant as a whole page at the given viewport size. */
  async labShot(c: string, variant: string, { round: roundId, width = 1280, height = 800 }: { round?: string; width?: number; height?: number } = {}) {
    const round = await this.labRound(c, roundId);
    if (!round.variants.some((v) => v.id === variant)) throw Error(`Round "${round.id}" has no variant "${variant}".`);
    return this.shot(c, 0, { lab: `${round.id}/${variant}`, width, height });
  }
  /** Picks the winning variant: it becomes the next iteration and the round closes. */
  async labPick(c: string, variant: string, roundId?: string) {
    const { round, html } = await this.labRead(c, variant, roundId);
    if (round.status === "picked") throw Error(`Round "${round.id}" already picked "${round.picked}" as v${round.pickedAs}.`);
    const label = round.variants.find((v) => v.id === variant)!.label;
    const out = await this.deliver(c, html, `${round.title} · ${label}`, {}, { round: round.id, variant });
    await this.saveRound(c, { ...round, status: "picked", picked: variant, pickedAs: out.v });
    return { v: out.v, round: round.id, variant };
  }

  /** Sets a component's artboard size (height null = follows the content).
   * artboard.json beside the iterations tells open editors to take the new size. */
  async setSize(c: string, size: { width?: number; height?: number | null }) {
    this.component(c);
    const state = this.readState();
    const comp = state.components.find((x) => x.id === c)!;
    if (size.width !== undefined) {
      if (!Number.isInteger(size.width) || size.width < 40 || size.width > 3000) throw Error("Width must be a whole number from 40 to 3000.");
      comp.width = size.width;
    }
    if (size.height !== undefined) {
      if (size.height !== null && (!Number.isInteger(size.height) || size.height < 20 || size.height > 6000))
        throw Error("Height must be a whole number from 20 to 6000, or auto.");
      comp.height = size.height;
    }
    this.saveState(state);
    await fsp.writeFile(path.join(this.components, c, "artboard.json"), JSON.stringify({ width: comp.width, height: comp.height ?? null, at: Date.now() }));
    this.addFeed("size", c, `Artboard set to ${comp.width} × ${comp.height ?? "auto"}`);
    return { width: comp.width, height: comp.height ?? null };
  }

  /** Calls back (debounced) when an iteration or response file changes. */
  watch(listener: () => void) {
    fs.mkdirSync(this.components, { recursive: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = fs.watch(this.components, { recursive: true }, (_e, file) => {
      if (file && !/(index\.html|response\.json|round\.json|artboard\.json)$|[\\/]lab[\\/].+\.html$/.test(file) && /\./.test(path.basename(file))) return;
      clearTimeout(timer);
      timer = setTimeout(listener, 500);
    });
    return () => { clearTimeout(timer); watcher.close(); };
  }

  // ---------- real-browser renders ----------
  private renderServer() {
    return (this.render ??= new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const send = (status: number, body: string | Buffer, type = "text/plain") => {
          res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
          res.end(body);
        };
        try {
          const url = new URL(req.url || "/", "http://x");
          const m = /^\/s\/([\w-]+)\/(.*)$/.exec(decodeURIComponent(url.pathname));
          const state = m && this.renderStates.get(m[1]!);
          if (!m || !state) return send(404, "Not found");
          const rest = m[2]!;
          if (rest === "shot.html") return send(200, await fsp.readFile(shotPage), MIME[".html"]);
          if (rest === "overlay.js") return send(200, await fsp.readFile(overlayScript), MIME[".js"]);
          if (rest === "state.json") return send(200, JSON.stringify(state), MIME[".json"]);
          const area = rest.startsWith("c/") ? "c" : rest.startsWith("refs/") ? "refs" : undefined;
          const file = area && this.resolve(area, rest.slice(area.length + 1));
          if (!file) return send(404, "Not found");
          send(200, await fsp.readFile(file), this.mime(file));
        } catch {
          send(404, "Not found");
        }
      });
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return reject(Error("No render port."));
        server.unref();
        resolve({ server, base: `http://127.0.0.1:${address.port}` });
      });
    }));
  }
  private launch() {
    if (!this.browser) {
      const executablePath = findBrowser();
      if (!executablePath) throw Error("No Chrome or Edge installation was found for UI Maker renders.");
      this.browser = import("@playwright/test").then(({ chromium }) =>
        chromium.launch({ executablePath, headless: true }),
      ) as Promise<Browser>;
      this.browser.then(
        (b) => b.on("disconnected", () => (this.browser = undefined)),
        () => (this.browser = undefined),
      );
    }
    return this.browser;
  }
  /** PNG of a version (clean or annotated) or of a reference board ("global" or a note ID). */
  async shot(c: string, v: number, { annot = false, board = "", state = this.readState(), lab = "", width = 1280, height = 800 } = {}) {
    const [browser, { base }] = await Promise.all([this.launch(), this.renderServer()]);
    const token = randomUUID();
    this.renderStates.set(token, state);
    const page = await browser.newPage({ viewport: { width: lab ? width : 1400, height: lab ? height : 900 }, deviceScaleFactor: lab ? 1 : 2 });
    try {
      const query = `c=${encodeURIComponent(c)}&v=${v}&annot=${annot ? 1 : 0}${board ? "&board=" + encodeURIComponent(board) : ""}${lab ? `&lab=${lab}&w=${width}&h=${height}` : ""}`;
      await page.goto(`${base}/s/${token}/shot.html?${query}`, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForFunction("window.__ready === true", undefined, { timeout: 15000 });
      const el = await page.$(board ? "#bsvg" : "#shot");
      if (!el) throw Error("The render page did not draw.");
      return await el.screenshot({ type: "png" });
    } finally {
      this.renderStates.delete(token);
      await page.close().catch(() => undefined);
    }
  }

  // ---------- brief ----------
  async brief(c: string, v?: number) {
    const st = this.readState();
    const comp = this.component(c);
    const vs = await this.versions(c);
    v ??= vs.at(-1)?.n;
    if (!v || !vs.some((x) => x.n === v)) throw Error(`Component "${c}" has no v${v}.`);
    const dir = await fsp.mkdtemp(path.join(this.components, c, `brief-v${v}-`));
    const warnings: string[] = [];
    const images: BriefImage[] = [];
    const capture = async (file: string, label: string, render: () => Promise<Buffer>) => {
      try {
        await fsp.writeFile(path.join(dir, file), await render());
        images.push({ file, path: unix(path.join(dir, file)), label });
        return true;
      } catch (error) {
        warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    const at = (file: string) => `\`${unix(path.join(dir, file))}\``;
    const refPath = (file: string) => `\`${unix(path.join(this.refs, file))}\``;
    const clean = await capture("clean.png", "Clean render (2x)", () => this.shot(c, v!, { state: st }));
    const annotated = await capture("annotated.png", "Annotated render (2x): numbered pins match the notes", () => this.shot(c, v!, { annot: true, state: st }));
    const of = <T extends { c: string; v: number }>(a: T[] = []) => a.filter((x) => x.c === c && x.v === v);
    const notes = of(st.notes), strokes = of(st.strokes), tweaks = of(st.tweaks);
    const next = Math.max(0, ...vs.map((x) => x.n)) + 1;
    const board = async (L: string[], o: Board, key: string, file: string, label: string) => {
      const refs = o.refs ?? [], pins = o.bpins ?? [], marks = o.bstrokes ?? [];
      if (!refs.length && !pins.length && !marks.length) return false;
      const ok = await capture(file, label, () => this.shot(c, v!, { board: key, state: st }));
      if (ok) L.push(`- Reference canvas as the user arranged and marked it: ${at(file)} — read this first. Strokes on an image circle or cross out the exact part meant (red = not this, green = this); lettered pins are comments.`);
      else L.push("- Reference canvas screenshot unavailable. Use the original images and annotations below.");
      if (pins.length) {
        L.push("- Pins on the references:");
        pins.forEach((p, i) => {
          const r = refs.find((r) => r.id === p.ref);
          const where = r ? ` — on ${refPath(r.file)} at ${Math.round(p.u * 100)}% across, ${Math.round((p.v / (r.ar || 0.66)) * 100)}% down` : "";
          L.push(`  - ${String.fromCharCode(65 + (i % 26))}: ${p.text || "(no text — see where it points)"}${where}`);
        });
      }
      if (marks.length) {
        L.push("- Marks on the reference canvas:");
        for (const s of marks) {
          const r = refs.find((r) => r.id === s.ref);
          const location = r ? ` on ${refPath(r.file)} (coordinates relative to image width)` : " on the board (canvas pixels)";
          L.push(`  - ${MEANING[s.color] || s.color}, ${s.tool}${location}: ${s.pts.map(([x, y]) => `${x},${y}`).join(" → ")}`);
        }
      }
      if (refs.length) {
        L.push("- Original image files, full resolution:");
        for (const r of refs) L.push(`  - ${refPath(r.file)}${r.caption ? ` — ${r.caption}` : ""}`);
      }
      return true;
    };

    const L: string[] = [];
    L.push(`# Brief — ${comp.name} · v${v} → v${next}`, "");
    L.push("Read the current implementation, the annotated render, and each reference board with its original images. Use each note’s references for that note only, and component-wide references for the overall design.", "");
    L.push("## Intent", comp.intent || "_(none written)_", "");
    L.push("## Current iteration");
    L.push(`- Component ID: \`${c}\``);
    L.push(`- Code: \`${unix(path.join(this.components, c, `v${v}`, "index.html"))}\``);
    L.push(`- Artboard width: ${comp.width}px, height: ${comp.height ? comp.height + "px" : "auto"}`);
    if (clean) L.push(`- Clean render (2x): ${at("clean.png")}`);
    if (annotated) L.push(`- Annotated render (2x): ${at("annotated.png")} — numbered pins match the notes below.`);
    if (!clean || !annotated) L.push("- One or more artboard screenshots were unavailable.");
    L.push("", `## Notes (${notes.length})`);
    if (!notes.length) L.push("_No pinned notes._");
    for (const [i, n] of notes.entries()) {
      L.push("", `### ${i + 1}. [${KIND[n.color] || "NOTE"}] ${n.title || "Note " + (i + 1)}  \`id: ${n.id}\``);
      if (n.text) L.push(n.text);
      L.push(n.elementPin ? `- HTML element pin: ${tgt(n.target)}` : `- Pinned at ${Math.round(n.x)},${Math.round(n.y)} on ${tgt(n.target)}`);
      const linked = strokes.filter((s) => s.note === n.id).length;
      if (linked) L.push(`- ${linked} sketch stroke(s) belong to this note`);
      await board(L, n, n.id, `board-note-${i + 1}.png`, `Reference canvas for note ${i + 1} (${n.title || "untitled"})`);
    }
    L.push("", `## Sketch strokes (${strokes.length})`);
    if (strokes.length) {
      L.push("Colour code: " + [...new Set(strokes.map((s) => MEANING[s.color] || s.color))].join(" · "));
      strokes.forEach((s, i) => {
        const ni = notes.findIndex((n) => n.id === s.note);
        L.push(`- S${i + 1}: ${(MEANING[s.color] || s.color).split(" — ")[0]} ${s.tool}, ${bbox(s.pts)}, over ${tgt(s.target)}${ni >= 0 ? ` (note ${ni + 1})` : ""}`);
      });
    } else L.push("_None._");
    L.push("", `## Direct adjustments (${tweaks.length})`);
    if (tweaks.length) {
      L.push("The user set these values by hand in the inspector. Apply them exactly, in the real CSS.");
      for (const t of tweaks) L.push(`- \`${t.selector}\` { ${t.prop}: ${t.value}; }${t.from ? `  (was ${t.from})` : ""}`);
    } else L.push("_None._");
    L.push("", "## Component-wide references");
    if (!(await board(L, comp, "global", "board-component.png", "Component-wide reference canvas"))) L.push("_None._");
    if (comp.target) {
      L.push("", "## Overlay target", `The user overlays ${refPath(comp.target)} on the artboard to judge fidelity.`);
      if (comp.match && comp.match.v === v) L.push(`Measured similarity of v${v} against it: ${comp.match.pct}%.`);
    }
    if (warnings.length) L.push("", "## Export warnings", ...warnings.map((w) => "- " + w));
    L.push("", "## Deliver");
    L.push(`1. Write v${next}: one self-contained HTML file (HTML + \`<style>\`, no build step, no external JS; web fonts by \`<link>\` are fine). Change what the notes ask for and leave everything else pixel-identical. Build real hover, focus and disabled states.`);
    L.push(`2. Deliver it with the \`uimaker_deliver\` tool (component \`${c}\`), with a one-line summary and one reply per note id. Never overwrite an existing version.`);
    L.push(`3. Check it with \`uimaker_render\` (v${next}) next to the references and the annotated render. If a note is not visibly addressed, deliver a corrected iteration.`);
    const markdown = L.join("\n") + "\n";
    await fsp.writeFile(path.join(dir, "brief.md"), markdown);
    const refCount = notes.reduce((a, n) => a + (n.refs?.length || 0), comp.refs?.length || 0);
    this.addFeed("brief", c, `Brief for v${v} exported — ${notes.length} note(s), ${strokes.length} stroke(s), ${refCount} reference(s), ${tweaks.length} exact value(s)`);
    const references = [...(comp.refs ?? []), ...notes.flatMap((n) => n.refs ?? [])].map((r) => ({
      file: r.file, path: unix(path.join(this.refs, r.file)), caption: r.caption ?? "",
    }));
    return { dir: unix(dir), brief: unix(path.join(dir, "brief.md")), v, next, markdown, images, references, warnings };
  }

  // ---------- one-time import from a standalone UI Maker workspace ----------
  /** Copies components, versions, notes, boards, feed and references from a
   * standalone UI Maker `workspace` folder. The source is only read. Components
   * whose ID already exists here are skipped. */
  async importWorkspace(from: string) {
    const source = path.resolve(from);
    let legacy: { state?: UiState; feed?: FeedItem[] } = {};
    const sqlite = path.join(source, "uimaker.sqlite");
    if (fs.existsSync(sqlite)) {
      const db = new Database(sqlite, { readonly: true, fileMustExist: true });
      try {
        const get = db.prepare("SELECT data FROM workspace_data WHERE key = ?");
        const read = (key: string) => {
          const row = get.get(key) as { data: string } | undefined;
          return row ? JSON.parse(row.data) : undefined;
        };
        legacy = { state: read("state"), feed: read("feed") };
      } finally {
        db.close();
      }
    } else if (fs.existsSync(path.join(source, "state.json"))) {
      legacy = { state: JSON.parse(await fsp.readFile(path.join(source, "state.json"), "utf8")) };
    }
    const from_ = legacy.state;
    if (!from_) throw Error(`No UI Maker workspace found in ${source}.`);
    from_.notes ??= []; from_.strokes ??= []; from_.tweaks ??= [];
    checkState(from_);
    const state = this.readState();
    const taken = new Set(state.components.map((c) => c.id));
    const added = from_.components.filter((c) => !taken.has(c.id));
    const ids = new Set(added.map((c) => c.id));
    await fsp.mkdir(this.components, { recursive: true });
    await fsp.mkdir(this.refs, { recursive: true });
    for (const c of added) {
      const dir = path.join(source, "components", c.id);
      if (fs.existsSync(dir)) await fsp.cp(dir, path.join(this.components, c.id), { recursive: true, errorOnExist: false, force: false });
    }
    const refDir = path.join(source, "refs");
    let refs = 0;
    for (const file of await fsp.readdir(refDir).catch(() => [] as string[])) {
      const to = path.join(this.refs, file);
      if (!fs.existsSync(to)) { await fsp.copyFile(path.join(refDir, file), to); refs++; }
    }
    const mine = <T extends { c: string }>(a: T[]) => a.filter((x) => ids.has(x.c));
    state.components.push(...added);
    state.notes.push(...mine(from_.notes));
    state.strokes.push(...mine(from_.strokes));
    state.tweaks.push(...mine(from_.tweaks));
    this.saveState(state);
    const feed = (legacy.feed ?? []).filter((f) => !f.c || ids.has(f.c));
    if (feed.length) this.database().saveAppData(FEED_KEY, [...feed, ...this.readFeed()].slice(-200));
    this.addFeed("import", undefined, `Imported ${added.length} component(s) and ${refs} reference image(s) from ${unix(source)}`);
    return { components: added.map((c) => c.id), skipped: from_.components.filter((c) => taken.has(c.id)).map((c) => c.id), refs };
  }

  async close() {
    this.db?.close();
    this.db = undefined;
    const browser = this.browser;
    this.browser = undefined;
    await browser?.then((b) => b.close()).catch(() => undefined);
    const render = this.render;
    this.render = undefined;
    await render?.then(({ server }) => new Promise((r) => server.close(r))).catch(() => undefined);
  }
}
