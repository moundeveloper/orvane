// Terminal app layout: tabs, each a tree of split panes. Saved as JSON in
// the terminal block's value. A pane's id is also its shell session's id.
export interface PaneNode {
  type: "pane";
  id: string;
  profile: string;
  cwd?: string;
}
export interface SplitNode {
  type: "split";
  id: string;
  /** "row": side by side; "column": one above the other. */
  dir: "row" | "column";
  /** Share of the first child, 0.1–0.9. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}
export type LayoutNode = PaneNode | SplitNode;
export interface TerminalTab {
  id: string;
  /** Set when the user renamed the tab; otherwise the shell's title shows. */
  name?: string;
  root: LayoutNode;
  focus: string;
}
export interface TerminalState {
  tabs: TerminalTab[];
  active: string;
  defaultProfile?: string;
  fontSize?: number;
}

const ID = /^[\w-]{6,64}$/;
function validNode(node: unknown, depth = 0): node is LayoutNode {
  if (!node || typeof node !== "object" || depth > 16) return false;
  const n = node as LayoutNode;
  if (n.type === "pane") return ID.test(n.id) && typeof n.profile === "string";
  return (
    n.type === "split" &&
    typeof n.id === "string" &&
    (n.dir === "row" || n.dir === "column") &&
    typeof n.ratio === "number" &&
    validNode(n.a, depth + 1) &&
    validNode(n.b, depth + 1)
  );
}
export function readTerminal(value: string): TerminalState {
  try {
    const data = JSON.parse(value || "{}") as Partial<TerminalState>;
    const tabs = (Array.isArray(data.tabs) ? data.tabs : []).filter(
      (tab) => tab && typeof tab.id === "string" && validNode(tab.root),
    );
    for (const tab of tabs) if (!panes(tab.root).some((p) => p.id === tab.focus)) tab.focus = panes(tab.root)[0]!.id;
    return {
      tabs,
      active: tabs.some((t) => t.id === data.active) ? data.active! : (tabs[0]?.id ?? ""),
      defaultProfile: typeof data.defaultProfile === "string" ? data.defaultProfile : undefined,
      fontSize: typeof data.fontSize === "number" ? Math.max(8, Math.min(32, data.fontSize)) : undefined,
    };
  } catch {
    return { tabs: [], active: "" };
  }
}
export function panes(node: LayoutNode): PaneNode[] {
  return node.type === "pane" ? [node] : [...panes(node.a), ...panes(node.b)];
}
/** The tree with `paneId` replaced by `replacement` (or removed, when null). */
export function replacePane(node: LayoutNode, paneId: string, replacement: LayoutNode | null): LayoutNode | null {
  if (node.type === "pane") return node.id === paneId ? replacement : node;
  const a = replacePane(node.a, paneId, replacement),
    b = replacePane(node.b, paneId, replacement);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}
