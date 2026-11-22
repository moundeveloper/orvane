import type { CanvasApp, Workspace } from "./model.ts";

export type RewindApp = Pick<
  CanvasApp,
  | "id"
  | "name"
  | "icon"
  | "x"
  | "y"
  | "width"
  | "height"
  | "archived"
  | "deleted"
  | "layoutHidden"
>;
export interface RewindState {
  apps: RewindApp[];
  layout?: string;
  layoutName?: string;
}
export interface RewindEntry {
  revision: number;
  at: number;
  author: "user" | "mcp";
  closed: boolean;
  description: string;
  state: RewindState;
}

export function captureRewind(workspace: Workspace): RewindState {
  const layout = workspace.layouts?.find(
    (item) => item.id === workspace.activeLayout,
  );
  return {
    apps: workspace.apps.map(
      ({
        id,
        name,
        icon,
        x,
        y,
        width,
        height,
        archived,
        deleted,
        layoutHidden,
      }) => ({
        id,
        name,
        icon,
        x,
        y,
        width,
        height,
        archived,
        ...(deleted ? { deleted: true } : {}),
        ...(layoutHidden ? { layoutHidden: true } : {}),
      }),
    ),
    ...(layout ? { layout: layout.id, layoutName: layout.name } : {}),
  };
}

export function rewindVisible(app: RewindApp) {
  return !app.archived && !app.deleted && !app.layoutHidden;
}

export function describeRewind(before: RewindState, after: RewindState) {
  const previous = before.apps.filter(rewindVisible);
  const current = after.apps.filter(rewindVisible);
  const byId = new Map(previous.map((app) => [app.id, app]));
  const ids = new Set(current.map((app) => app.id));
  const closed = previous.filter((app) => !ids.has(app.id));
  const opened = current.filter((app) => !byId.has(app.id));
  const changed = current.filter((app) => {
    const old = byId.get(app.id);
    return (
      old &&
      (app.x !== old.x ||
        app.y !== old.y ||
        app.width !== old.width ||
        app.height !== old.height ||
        app.name !== old.name)
    );
  });
  const count = closed.length + opened.length + changed.length;
  let description = "Canvas updated";
  if (before.layout !== after.layout)
    description = after.layoutName
      ? `Switched to ${after.layoutName}`
      : "Left layout";
  else if (count > 1) description = `${count} apps changed`;
  else if (closed[0]) description = `Closed ${closed[0].name || "app"}`;
  else if (opened[0]) description = `Opened ${opened[0].name || "app"}`;
  else if (changed[0]) description = `Updated ${changed[0].name || "app"}`;
  return { closed: closed.length > 0, description };
}

/** Apply the window arrangement to existing app records, keeping their content. */
export function restoreRewind(
  workspace: Workspace,
  state: RewindState,
  appId?: string,
) {
  const historical = new Map(state.apps.map((app) => [app.id, app]));
  for (const app of workspace.apps) {
    if (appId && appId !== app.id) continue;
    const old = historical.get(app.id);
    if (!old) {
      if (!appId && rewindVisible(app)) app.archived = true;
      continue;
    }
    const { x, y, width, height, archived, deleted, layoutHidden } = old;
    Object.assign(app, {
      x,
      y,
      width,
      height,
      archived,
      deleted,
      layoutHidden,
    });
    if (appId) {
      app.archived = false;
      delete app.deleted;
      delete app.layoutHidden;
    }
  }
  if (appId) return;
  const order = new Map(state.apps.map((app, index) => [app.id, index]));
  workspace.apps.sort(
    (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
  );
  workspace.activeLayout = workspace.layouts?.some(
    (layout) => layout.id === state.layout,
  )
    ? state.layout
    : undefined;
}
