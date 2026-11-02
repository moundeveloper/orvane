import { createApp, h, reactive, ref } from "vue";
import Scripts from "../src/components/NetSuiteScripts.vue";
import Cabinet from "../src/components/NetSuiteFileCabinet.vue";
import type { Block } from "../src/model";

export function mountScriptsFixture(
  kind: "scripts" | "search" = "scripts",
  count = 5000,
  deploymentCount = 5,
) {
  const root = document.createElement("div");
  root.id = "scripts-fixture";
  root.style.cssText =
    "position:fixed;inset:0;z-index:999999;background:#f7f9fa;color:#455968;font-size:12px;display:flex;flex-direction:column;";
  document.body.appendChild(root);
  const block = reactive({
    id: "fixture",
    kind: "netsuite",
    value: "{}",
  }) as unknown as Block;
  const environment = ref("fixture");
  const calls: { op: string; args: Record<string, any> }[] = [];
  const opened: { kind: string; id: unknown }[] = [];
  const edited: { id: number; name: string }[] = [];
  const rows = Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Script ${String(i).padStart(5, "0")}`,
    scriptfile: `fixture-${i}.js`,
    fileid: i + 10000,
    owner: "Fixture owner",
    scriptid: `customscript_fixture_${i}`,
    scripttype: i % 2 ? "Scheduled" : "UserEvent",
  }));
  let held: Promise<void> | undefined;
  let releaseHeld: (() => void) | undefined;
  let rejectHeld: ((reason: Error) => void) | undefined;
  const request = async (op: string, args: Record<string, any> = {}) => {
    calls.push({ op, args });
    if (op === "scripts") return { rows };
    if (op === "deployments") {
      const pending = held;
      held = undefined;
      if (pending) await pending;
      return {
        rows: Array.from({ length: deploymentCount }, (_, i) => ({
          primarykey: Number(args.id) * 10 + i,
          scriptid: `customdeploy_${args.id}_${i}`,
          status: "Released",
          recordtype: "Customer",
          isdeployed: true,
          loglevel: "DEBUG",
        })),
      };
    }
    if (op === "script-logs")
      return {
        totalCount: 1000,
        rows: Array.from({ length: 100 }, (_, i) => ({
          internalid: i + 1,
          date: "2026-11-02",
          time: "12:00",
          type: "DEBUG",
          title: `Log ${i}`,
          detail: `Message ${i}: ${"fixture detail ".repeat((i % 4) + 1)}`,
        })),
      };
    if (op === "file")
      return {
        id: args.id,
        name: "fixture.js",
        content: "// Script fixture\n".repeat(20),
        binary: false,
      };
    if (op === "search-files")
      return {
        folders: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          name: `Folder ${i}`,
          parentname: "Root",
        })),
        files: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1000,
          name: `File ${i}.js`,
          filetype: "JAVASCRIPT",
          folder: 1,
          foldername: "Root",
        })),
      };
    return { rows: [] };
  };
  const app = createApp({
    render: () =>
      kind === "scripts"
        ? h(Scripts, {
            block,
            environment: environment.value,
            request,
            openRecord: (kind, id) => opened.push({ kind, id }),
            "onEdit-file": (file) => edited.push(file),
          })
        : h(Cabinet, { block, environment: environment.value, request }),
  });
  app.mount(root);
  return {
    calls,
    opened,
    edited,
    holdDeployments() {
      held = new Promise<void>((resolve, reject) => {
        releaseHeld = resolve;
        rejectHeld = reject;
      });
    },
    releaseDeployments() {
      releaseHeld?.();
    },
    rejectDeployments() {
      rejectHeld?.(new Error("Fixture deployment error"));
    },
    changeEnvironment() {
      environment.value = "other";
    },
    resize(width: number, height: number, zoom = 1) {
      root.style.width = `${width}px`;
      root.style.height = `${height}px`;
      root.style.transform = `scale(${zoom})`;
      root.style.transformOrigin = "top left";
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}
