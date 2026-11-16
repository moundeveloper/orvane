// Geometry for canvas boards: where arrow ends attach, hit testing for the
// eraser and selection, and thinning freehand strokes.
import type { Board, BoardEnd, CanvasApp, Workspace } from "./model";

export type Tool = "select" | "note" | "arrow" | "pen" | "eraser";
export const BOARD_COLORS = ["#4f7b93", "#c2463f", "#2f7a4c", "#b48a12", "#7a5cc0", "#344f5e"];
export const NOTE_COLORS = ["#fff4b8", "#d9ecf7", "#dcefe2", "#f9dde3", "#ece4f7"];

export function ensureBoard(workspace: Workspace): Board {
  workspace.board ??= { notes: [], arrows: [], strokes: [] };
  return workspace.board;
}
type Rect = { x: number; y: number; width: number; height: number };
export function rectOf(end: BoardEnd, apps: CanvasApp[], board: Board): Rect | null {
  if (end.appId) {
    const app = apps.find((a) => a.id === end.appId);
    return app ? { x: app.x, y: app.y, width: app.width, height: app.height } : null;
  }
  if (end.noteId) return board.notes.find((n) => n.id === end.noteId) ?? null;
  return null;
}
// Where a line from the rect's centre towards `toward` leaves the rect.
function edgePoint(rect: Rect, toward: { x: number; y: number }, gap = 6) {
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  const dx = toward.x - cx,
    dy = toward.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const scale = Math.min(
    dx ? (rect.width / 2 + gap) / Math.abs(dx) : Infinity,
    dy ? (rect.height / 2 + gap) / Math.abs(dy) : Infinity,
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}
const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
// The two visible end points of an arrow, or null when an attached item is
// hidden or gone and the arrow should not be drawn.
export function arrowPoints(arrow: Board["arrows"][number], apps: CanvasApp[], board: Board, allApps: CanvasApp[]) {
  const attachedMissing = (end: BoardEnd) =>
    !!end.appId && !apps.some((a) => a.id === end.appId) && allApps.some((a) => a.id === end.appId);
  if (attachedMissing(arrow.from) || attachedMissing(arrow.to)) return null;
  const fromRect = rectOf(arrow.from, apps, board),
    toRect = rectOf(arrow.to, apps, board);
  const fromAim = toRect ? centre(toRect) : arrow.to;
  const toAim = fromRect ? centre(fromRect) : arrow.from;
  return {
    a: fromRect ? edgePoint(fromRect, fromAim) : { x: arrow.from.x, y: arrow.from.y },
    b: toRect ? edgePoint(toRect, toAim) : { x: arrow.to.x, y: arrow.to.y },
  };
}
export function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
export function hitStroke(points: number[], p: { x: number; y: number }, tolerance: number) {
  for (let i = 0; i + 3 < points.length; i += 2)
    if (distanceToSegment(p, { x: points[i]!, y: points[i + 1]! }, { x: points[i + 2]!, y: points[i + 3]! }) <= tolerance)
      return true;
  return points.length === 2 && Math.hypot(p.x - points[0]!, p.y - points[1]!) <= tolerance;
}
// Drops points closer than `min` to the previous kept one.
export function thin(points: number[], min: number) {
  if (points.length <= 4) return points;
  const out = [points[0]!, points[1]!];
  for (let i = 2; i < points.length; i += 2) {
    const x = points[i]!,
      y = points[i + 1]!;
    if (Math.hypot(x - out[out.length - 2]!, y - out[out.length - 1]!) >= min || i === points.length - 2) out.push(x, y);
  }
  return out.map((v) => Math.round(v * 10) / 10);
}
// A smooth SVG path through the points (quadratic midpoints).
export function strokePath(points: number[]) {
  if (points.length < 4) return points.length === 2 ? `M${points[0]} ${points[1]}l0.01 0` : "";
  let d = `M${points[0]} ${points[1]}`;
  for (let i = 2; i + 3 < points.length; i += 2) {
    const mx = (points[i]! + points[i + 2]!) / 2,
      my = (points[i + 1]! + points[i + 3]!) / 2;
    d += `Q${points[i]} ${points[i + 1]} ${mx} ${my}`;
  }
  return d + `L${points[points.length - 2]} ${points[points.length - 1]}`;
}
