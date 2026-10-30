// Tab layout shared by the NetSuite workspace and the File Cabinet: one tab
// strip, or two groups side by side, like Magic NetSuite's ViewTabsWorkspace.
export type SplitSide = "left" | "right";
export type SplitLayout = {
  tabs: string[];
  active: string;
  left: string[];
  right: string[];
  leftActive: string;
  rightActive: string;
  ratio: number;
};

export function splitLayout(tabs: string[] = [], active = tabs[0] ?? ""): SplitLayout {
  return { tabs, active, left: [], right: [], leftActive: "", rightActive: "", ratio: 50 };
}

export function isSplit(layout: SplitLayout) {
  return layout.left.length > 0 && layout.right.length > 0;
}

export function groupOf(layout: SplitLayout, id: string): SplitSide | null {
  return layout.left.includes(id) ? "left" : layout.right.includes(id) ? "right" : null;
}

// Drops stale ids and collapses a split that lost one side.
export function normalize(layout: SplitLayout) {
  const valid = new Set(layout.tabs);
  layout.left = layout.left.filter((id) => valid.has(id));
  layout.right = layout.right.filter((id) => valid.has(id));
  if (!valid.has(layout.active)) layout.active = layout.tabs[0] ?? "";
  if (isSplit(layout)) {
    if (!layout.left.includes(layout.leftActive)) layout.leftActive = layout.left[0]!;
    if (!layout.right.includes(layout.rightActive)) layout.rightActive = layout.right[0]!;
    if (!groupOf(layout, layout.active)) layout.active = layout.leftActive;
  } else {
    layout.left = [];
    layout.right = [];
    layout.leftActive = "";
    layout.rightActive = "";
  }
  layout.ratio = Math.min(80, Math.max(20, Number(layout.ratio) || 50));
}

export function activate(layout: SplitLayout, id: string) {
  if (!layout.tabs.includes(id)) return;
  layout.active = id;
  if (layout.left.includes(id)) layout.leftActive = id;
  if (layout.right.includes(id)) layout.rightActive = id;
}

// Adds a tab after `after` (or at the end) in the focused group.
export function addTab(layout: SplitLayout, id: string, group?: SplitSide | null, after?: string) {
  const at = after ? layout.tabs.indexOf(after) : -1;
  layout.tabs.splice(at >= 0 ? at + 1 : layout.tabs.length, 0, id);
  if (isSplit(layout)) {
    const side = group ?? groupOf(layout, layout.active) ?? "right",
      list = side === "left" ? layout.left : layout.right,
      index = after ? list.indexOf(after) : -1;
    list.splice(index >= 0 ? index + 1 : list.length, 0, id);
  }
  activate(layout, id);
}

export function closeTab(layout: SplitLayout, id: string) {
  const index = layout.tabs.indexOf(id);
  if (index < 0 || layout.tabs.length < 2) return null;
  const group = groupOf(layout, id),
    wasActive = layout.active === id,
    list = group === "left" ? layout.left : group === "right" ? layout.right : layout.tabs,
    position = list.indexOf(id),
    neighbour = list[position + 1] ?? list[position - 1];
  layout.tabs.splice(index, 1);
  normalize(layout);
  if (wasActive)
    activate(
      layout,
      neighbour && layout.tabs.includes(neighbour)
        ? neighbour
        : isSplit(layout)
          ? layout.leftActive
          : layout.tabs[Math.min(index, layout.tabs.length - 1)]!,
    );
  return { id, group, index };
}

export function reopenTab(layout: SplitLayout, closed: { id: string; group: SplitSide | null; index: number }) {
  layout.tabs.splice(Math.min(closed.index, layout.tabs.length), 0, closed.id);
  if (isSplit(layout)) (closed.group === "left" ? layout.left : layout.right).push(closed.id);
  activate(layout, closed.id);
}

export function splitWith(layout: SplitLayout, id: string, side: SplitSide) {
  if (!layout.tabs.includes(id) || layout.tabs.length < 2) return;
  if (!isSplit(layout)) {
    const others = layout.tabs.filter((x) => x !== id);
    const focus = others.includes(layout.active) ? layout.active : others[0]!;
    if (side === "left") {
      layout.left = [id];
      layout.right = others;
      layout.leftActive = id;
      layout.rightActive = focus;
    } else {
      layout.left = others;
      layout.right = [id];
      layout.leftActive = focus;
      layout.rightActive = id;
    }
  } else moveToGroup(layout, id, side);
  activate(layout, id);
  normalize(layout);
}

export function moveToGroup(layout: SplitLayout, id: string, side: SplitSide, before?: string, place: "before" | "after" = "before") {
  if (!isSplit(layout)) return;
  layout.left = layout.left.filter((x) => x !== id);
  layout.right = layout.right.filter((x) => x !== id);
  const list = side === "left" ? layout.left : layout.right,
    at = before ? list.indexOf(before) : -1;
  list.splice(at >= 0 ? at + (place === "after" ? 1 : 0) : list.length, 0, id);
  normalize(layout);
  activate(layout, id);
}

export function reorder(layout: SplitLayout, id: string, target: string, place: "before" | "after") {
  if (id === target) return;
  const group = groupOf(layout, target);
  if (group && groupOf(layout, id) !== group) return moveToGroup(layout, id, group, target, place);
  const lists = group ? [layout.tabs, group === "left" ? layout.left : layout.right] : [layout.tabs];
  for (const list of lists) {
    const from = list.indexOf(id);
    if (from < 0) continue;
    list.splice(from, 1);
    const to = list.indexOf(target);
    list.splice(to + (place === "after" ? 1 : 0), 0, id);
  }
  activate(layout, id);
}

export function restoreLayout(saved: unknown, valid: string[]): SplitLayout | null {
  const s = saved as Partial<SplitLayout> | null;
  if (!s || !Array.isArray(s.tabs)) return null;
  const ids = (list: unknown) =>
    Array.isArray(list) ? list.filter((id): id is string => typeof id === "string" && valid.includes(id)) : [];
  const layout: SplitLayout = {
    tabs: ids(s.tabs),
    active: String(s.active ?? ""),
    left: ids(s.left),
    right: ids(s.right),
    leftActive: String(s.leftActive ?? ""),
    rightActive: String(s.rightActive ?? ""),
    ratio: Number(s.ratio) || 50,
  };
  if (!layout.tabs.length) return null;
  normalize(layout);
  return layout;
}
