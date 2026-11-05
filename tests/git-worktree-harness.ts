import { createApp, h, reactive } from "vue";
import GitViewer from "../src/components/GitViewer.vue";
import { makeBlock } from "../src/model";

export function mountGitWorktreeFixture(workspaceId: string) {
  const root = document.createElement("div");
  root.id = "git-worktree-fixture";
  root.style.cssText = "position:fixed;left:40px;top:40px;width:1160px;height:800px;z-index:500;background:#f7f9fa";
  document.body.appendChild(root);
  const block = reactive(makeBlock("git"));
  block.gitWorkspaceId = workspaceId;
  const app = createApp({ render: () => h(GitViewer, { block, editing: false }) });
  app.mount(root);
  return { unmount() { app.unmount(); root.remove(); } };
}
