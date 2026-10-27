import { uid, type Workspace, type CanvasApp } from "./model";

export function migrateGroups(workspace: Workspace) {
  workspace.groups ||= [];
  for (const app of workspace.apps) {
    const known = workspace.groups.find((g) => g.id === app.groupId);
    if (known) {
      app.group = known.name;
      continue;
    }
    if (!app.group.trim()) {
      delete app.groupId;
      continue;
    }
    let group = workspace.groups.find((g) => g.name === app.group);
    if (!group) {
      group = { id: uid(), name: app.group };
      workspace.groups.push(group);
    }
    app.groupId = group.id;
  }
}
export function groupBounds(apps: CanvasApp[]) {
  if (!apps.length) return undefined;
  const x = Math.min(...apps.map((a) => a.x)) - 22,
    y = Math.min(...apps.map((a) => a.y)) - 42;
  return {
    x,
    y,
    width: Math.max(...apps.map((a) => a.x + a.width)) + 22 - x,
    height: Math.max(...apps.map((a) => a.y + a.height)) + 22 - y,
  };
}
