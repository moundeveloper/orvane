// Agent Sessions split panes: a tree of row/column splits like the Terminal's
// (src/terminalLayout.ts), laid out as Hyprland-style tiles. A leaf is a pane
// id; the pane's session lives in the host's `panes` record, keyed by that id.
// "host" is the pane the Agent Sessions app itself draws; it always exists.
import type { AgentProvider } from "./agentSessions";

export type TileLeaf = { type: "pane"; id: string };
export type TileSplit = { type: "split"; id: string; dir: "row" | "column"; ratio: number; a: TileNode; b: TileNode };
export type TileNode = TileLeaf | TileSplit;
export type TileRect = { x: number; y: number; w: number; h: number };
export type TileGap = TileRect & { id: string; dir: "row" | "column"; box: TileRect };
export type TileEdge = "left" | "right" | "top" | "bottom";
/** What a pane other than the host shows: a session, or a new one being set up. */
export type PaneSession = { key?: string; provider?: AgentProvider; folder?: string };
export type TilesState = { root: TileNode; focus: string; panes: Record<string, PaneSession> };

export const HOST = "host";
/** Hyprland defaults (example/hyprland.lua): gaps_in 5 per side, rounding 10. */
export const TILE_GAP = 10;
export const TILE_PAD = 10;
export const TILE_MIN = 0.2;

let counter = 0;
export const tileId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(++counter).toString(36)}`;
export const leaf = (id: string): TileLeaf => ({ type: "pane", id });
export const split = (dir: "row" | "column", a: TileNode, b: TileNode, ratio = 0.5): TileSplit =>
  ({ type: "split", id: tileId("split"), dir, ratio, a, b });

export function leaves(node: TileNode | null | undefined): string[] {
  return !node ? [] : node.type === "pane" ? [node.id] : [...leaves(node.a), ...leaves(node.b)];
}
/** The tree with `id` replaced by `replacement`, or removed when it is null. */
export function replaceLeaf(node: TileNode, id: string, replacement: TileNode | null): TileNode | null {
  if (node.type === "pane") return node.id === id ? replacement : node;
  const a = replaceLeaf(node.a, id, replacement),
    b = replaceLeaf(node.b, id, replacement);
  if (!a) return b;
  if (!b) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}
export function findSplit(node: TileNode, id: string): TileSplit | null {
  if (node.type === "pane") return null;
  return node.id === id ? node : findSplit(node.a, id) || findSplit(node.b, id);
}
/** `id` placed against one edge of `target`. */
export function insertAt(root: TileNode, target: string, id: string, edge: TileEdge): TileNode {
  const dir = edge === "left" || edge === "right" ? "row" : "column";
  const first = edge === "left" || edge === "top";
  return replaceLeaf(root, target, first ? split(dir, leaf(id), leaf(target)) : split(dir, leaf(target), leaf(id)))!;
}
export function swapLeaves(node: TileNode, a: string, b: string): TileNode {
  if (node.type === "pane") return node.id === a ? leaf(b) : node.id === b ? leaf(a) : node;
  return { ...node, a: swapLeaves(node.a, a, b), b: swapLeaves(node.b, a, b) };
}

/** Pane rectangles and the gaps between them. One pane fills the area with no gaps. */
export function layoutTiles(root: TileNode, width: number, height: number) {
  const rects = new Map<string, TileRect>();
  const gaps: TileGap[] = [];
  const single = root.type === "pane";
  const pad = single ? 0 : TILE_PAD,
    gap = single ? 0 : TILE_GAP;
  (function place(node: TileNode, r: TileRect) {
    if (node.type === "pane") return void rects.set(node.id, r);
    if (node.dir === "row") {
      const room = Math.max(0, r.w - gap),
        a = Math.round(room * node.ratio);
      place(node.a, { x: r.x, y: r.y, w: a, h: r.h });
      gaps.push({ id: node.id, dir: "row", x: r.x + a, y: r.y, w: gap, h: r.h, box: r });
      place(node.b, { x: r.x + a + gap, y: r.y, w: room - a, h: r.h });
    } else {
      const room = Math.max(0, r.h - gap),
        a = Math.round(room * node.ratio);
      place(node.a, { x: r.x, y: r.y, w: r.w, h: a });
      gaps.push({ id: node.id, dir: "column", x: r.x, y: r.y + a, w: r.w, h: gap, box: r });
      place(node.b, { x: r.x, y: r.y + a + gap, w: r.w, h: room - a });
    }
  })(root, { x: pad, y: pad, w: Math.max(0, width - 2 * pad), h: Math.max(0, height - 2 * pad) });
  return { rects, gaps };
}

/** The nearest pane in a direction, for Alt+arrows. */
export function neighbour(rects: Map<string, TileRect>, id: string, key: string): string | null {
  const r = rects.get(id);
  if (!r) return null;
  let best: string | null = null,
    bestDistance = Infinity;
  for (const [other, q] of rects) {
    if (other === id) continue;
    const across = q.y < r.y + r.h && q.y + q.h > r.y,
      along = q.x < r.x + r.w && q.x + q.w > r.x;
    const ok =
      key === "ArrowLeft" ? q.x + q.w <= r.x + 1 && across
      : key === "ArrowRight" ? q.x >= r.x + r.w - 1 && across
      : key === "ArrowUp" ? q.y + q.h <= r.y + 1 && along
      : key === "ArrowDown" ? q.y >= r.y + r.h - 1 && along
      : false;
    if (!ok) continue;
    const d = Math.hypot(q.x + q.w / 2 - (r.x + r.w / 2), q.y + q.h / 2 - (r.y + r.h / 2));
    if (d < bestDistance) {
      bestDistance = d;
      best = other;
    }
  }
  return best;
}

function validNode(node: unknown, depth = 0): node is TileNode {
  if (!node || typeof node !== "object" || depth > 12) return false;
  const n = node as TileNode;
  if (n.type === "pane") return typeof n.id === "string" && !!n.id;
  return n.type === "split" && typeof n.id === "string" && (n.dir === "row" || n.dir === "column") &&
    typeof n.ratio === "number" && validNode(n.a, depth + 1) && validNode(n.b, depth + 1);
}
/** Saved split panes, or null when there are none worth restoring. */
export function readTiles(value: unknown): TilesState | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<TilesState>;
  if (!validNode(data.root)) return null;
  const ids = leaves(data.root);
  if (ids.length < 2 || !ids.includes(HOST) || new Set(ids).size !== ids.length) return null;
  const panes: Record<string, PaneSession> = {};
  for (const id of ids) {
    if (id === HOST) continue;
    const pane = (data.panes as Record<string, PaneSession> | undefined)?.[id];
    panes[id] = {
      key: typeof pane?.key === "string" ? pane.key : undefined,
      provider: pane?.provider === "claude" || pane?.provider === "codex" ? pane.provider : undefined,
      folder: typeof pane?.folder === "string" ? pane.folder : undefined,
    };
  }
  (function clamp(n: TileNode) {
    if (n.type === "pane") return;
    n.ratio = Math.min(1 - TILE_MIN, Math.max(TILE_MIN, n.ratio));
    clamp(n.a);
    clamp(n.b);
  })(data.root);
  return { root: data.root, focus: ids.includes(data.focus ?? "") ? data.focus! : HOST, panes };
}
