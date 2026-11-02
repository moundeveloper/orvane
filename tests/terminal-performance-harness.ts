import { createApp, h, ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import TerminalPanel from "../src/components/projects/TerminalPanel.vue";
import type { TerminalState } from "../src/components/projects/types";
import "../src/components/projects/projects.css";

export function mountTerminalFixture(count = 50, open = true) {
  const terminals: { host: HTMLElement; terminal: Terminal }[] = [];
  let fits = 0;
  let changes = 0;
  let lastState: TerminalState | undefined;
  const calls: { cwd: string; command: string }[] = [];
  const completions: ((value: {
    stdOut: string;
    stdErr: string;
    exitCode: number;
  }) => void)[] = [];
  const originalOpen = Terminal.prototype.open;
  const originalFit = FitAddon.prototype.fit;
  Terminal.prototype.open = function (host: HTMLElement) {
    terminals.push({ host, terminal: this });
    return originalOpen.call(this, host);
  };
  FitAddon.prototype.fit = function () {
    fits++;
    return originalFit.call(this);
  };
  const paths = Array.from(
    { length: count },
    (_, i) => `C:\\fixture\\project-${i}`,
  );
  const state: TerminalState = {
    isOpen: open,
    isMaximized: false,
    height: 230,
    activeCwd: paths[0],
    tabs: paths.map((cwd) => ({ cwd, title: cwd.split("\\").at(-1)! })),
  };
  const panel = ref<InstanceType<typeof TerminalPanel>>();
  const root = document.createElement("div");
  root.id = "terminal-fixture";
  root.className = "projects-hub";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;display:flex;flex-direction:column;";
  document.body.appendChild(root);
  const app = createApp({
    render: () =>
      h(TerminalPanel, {
        ref: panel,
        initialCwd: paths[0]!,
        state,
        runCommand: (cwd: string, command: string) => {
          calls.push({ cwd, command });
          return new Promise((resolve) => completions.push(resolve));
        },
        onStateChange: (next: TerminalState) => {
          changes++;
          lastState = next;
        },
      }),
  });
  app.mount(root);
  const active = () =>
    terminals.find(
      (entry) =>
        entry.host.getBoundingClientRect().width > 0 &&
        entry.host.getBoundingClientRect().height > 0,
    );
  return {
    paths,
    calls,
    get fits() {
      return fits;
    },
    get changes() {
      return changes;
    },
    get state() {
      return lastState;
    },
    resetFits() {
      fits = 0;
    },
    focus() {
      active()?.terminal.focus();
    },
    text(cwd: string) {
      const index = paths.indexOf(cwd);
      const host = root.querySelectorAll<HTMLElement>(".terminal-host")[index];
      const terminal = terminals.find((entry) => entry.host === host)?.terminal;
      if (!terminal) return "";
      const buffer = terminal.buffer.active;
      return Array.from(
        { length: buffer.length },
        (_, i) => buffer.getLine(i)?.translateToString(true) ?? "",
      ).join("\n");
    },
    complete(index: number, text = "Controlled output") {
      completions[index]?.({ stdOut: text, stdErr: "", exitCode: 0 });
    },
    addTabs() {
      return Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          panel.value!.addTab(`C:\\fixture\\new-${i}`),
        ),
      );
    },
    unmount() {
      app.unmount();
      root.remove();
      Terminal.prototype.open = originalOpen;
      FitAddon.prototype.fit = originalFit;
    },
  };
}
