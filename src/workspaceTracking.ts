import { watch, type WatchHandle } from "vue";
import type { CanvasApp, Workspace } from "./model";

// The membership watcher observes identities only. Deep traversal is confined
// to the changed app; workspace metadata never traverses the apps array.
export function trackWorkspace(workspace: Workspace, changed: () => void) {
  const apps = new Map<CanvasApp, WatchHandle>();
  let paused = false;
  const membership = watch(
    () => [...workspace.apps],
    (current, previous) => {
      for (const [app, handle] of apps) {
        if (!current.includes(app)) {
          handle.stop();
          apps.delete(app);
        }
      }
      for (const app of current) {
        if (apps.has(app)) continue;
        const handle = watch(app, changed, { deep: true, flush: "sync" });
        if (paused) handle.pause();
        apps.set(app, handle);
      }
      if (previous) changed();
    },
    { immediate: true, flush: "sync" },
  );
  const metadata = watch(
    () => {
      const { apps: _apps, ...rest } = workspace;
      return rest;
    },
    changed,
    { deep: true, flush: "sync" },
  );
  return {
    pause() {
      paused = true;
      metadata.pause();
      for (const handle of apps.values()) handle.pause();
    },
    resume() {
      paused = false;
      metadata.resume();
      for (const handle of apps.values()) handle.resume();
    },
    stop() {
      membership.stop();
      metadata.stop();
      for (const handle of apps.values()) handle.stop();
      apps.clear();
    },
  };
}
