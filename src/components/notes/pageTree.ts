import type { InjectionKey } from "vue";
import type { Page } from "./types";

/** Ids of the pages whose subpages are shown, shared by one sidebar's rows. */
export const TREE_EXPANDED: InjectionKey<Set<string>> = Symbol("notesTree");

/** Every page tree row is this tall (see .pt-row). */
export const TREE_ROW_HEIGHT = 28;

export interface TreeRow {
  page: Page;
  depth: number;
}

/** The visible tree as a flat list: each page, then its children if expanded. */
export function flattenTree(
  childrenOf: (parentId: string | null) => Page[],
  expanded: ReadonlySet<string>,
) {
  const rows: TreeRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const page of childrenOf(parentId)) {
      rows.push({ page, depth });
      if (expanded.has(page.id)) visit(page.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** Rows to mount for a scroll position, with overscan; all of a short list. */
export function treeWindow(
  count: number,
  scrollTop: number,
  viewHeight: number,
  listTop: number,
  overscan = 10,
  threshold = 100,
) {
  if (count <= threshold || viewHeight <= 0) return { start: 0, end: count };
  const first = Math.floor((scrollTop - listTop) / TREE_ROW_HEIGHT);
  const visible = Math.ceil(viewHeight / TREE_ROW_HEIGHT);
  const start = Math.max(0, Math.min(count, first - overscan));
  return { start, end: Math.min(count, Math.max(start, first + visible + overscan)) };
}
