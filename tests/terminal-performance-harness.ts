import { createApp, h, ref } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import TerminalPanel from "../src/components/projects/TerminalPanel.vue";
import type { TerminalState } from "../src/components/projects/types";
import { makeBlock } from "../src/model";
import { terminal as client, type SessionListener } from "../src/terminalClient";
import "../src/components/projects/projects.css";

export function mountTerminalFixture(count = 50, open = true) {
  const terminals: { host: HTMLElement; terminal: Terminal }[] = [];
  let fits = 0;
  let changes = 0;
  let lastState: TerminalState | undefined;
  const calls: { cwd: string; command: string }[] = [];
  const completions: ((text: string) => void)[] = [];
  const sessions = new Map<string, { cwd: string; draft: string; last: string; output: string; listener?: SessionListener }>();
  const opened: string[] = [];
  const killed: string[] = [];
  const attached: string[] = [];
  const resizes: { id: string; cols: number; rows: number }[] = [];
  const originalClient = { ...client };
  client.open = (id, options, listener) => {
    const existing = sessions.get(id);
    if (existing) {
      existing.listener = listener;
      attached.push(id);
      listener.attached(existing.output);
      return;
    }
    opened.push(id);
    sessions.set(id, { cwd: options.cwd ?? "", draft: "", last: "", output: "", listener });
    listener.started("Fixture shell");
  };
  client.input = (id, data) => {
    const session = sessions.get(id)!;
    if (data === "\x1b[A") session.draft = session.last;
    else if (data === "\r") {
      const command = session.draft;
      session.draft = "";
      session.last = command;
      calls.push({ cwd: session.cwd, command });
      completions.push((text) => {
        const output = command + "\r\n" + text + "\r\n";
        session.output += output;
        session.listener?.output(output);
      });
    } else session.draft += data;
  };
  client.listen = (id, listener) => { const session = sessions.get(id); if (session) session.listener = listener; };
  client.resize = (id, cols, rows) => { resizes.push({ id, cols, rows }); };
  client.detach = (id) => { const session = sessions.get(id); if (session) delete session.listener; };
  client.kill = (id) => { killed.push(id); sessions.delete(id); };
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
  const block = makeBlock("projects");
  const root = document.createElement("div");
  root.id = "terminal-fixture";
  root.className = "projects-hub";
  root.style.cssText =
    "position:fixed;inset:0;background:white;z-index:999999;display:flex;flex-direction:column;";
  document.body.appendChild(root);
  const app = createApp({
    render: () =>
      h(TerminalPanel, {
        block,
        ref: panel,
        initialCwd: paths[0]!,
        state,
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
    opened,
    killed,
    attached,
    resizes,
    get xterms() {
      return terminals.length;
    },
    get fits() {
      return fits;
    },
    get changes() {
      return changes;
    },
    get state() {
      return lastState ?? state;
    },
    resetFits() {
      fits = 0;
    },
    exit(id: string, code: number) {
      const session = sessions.get(id)!;
      sessions.delete(id);
      session.listener?.exit(code);
    },
    write(host: Element, text: string) {
      const terminal = terminals.find(({ terminal }) => terminal.element?.parentElement === host)!.terminal;
      return new Promise<void>((resolve) => terminal.write(text, resolve));
    },
    focus() {
      active()?.terminal.focus();
    },
    viewportY(paneId: string) {
      return terminals.find(({ host }) =>
        host.isConnected && host.closest<HTMLElement>("[data-terminal-pane]")?.dataset.terminalPane === paneId,
      )?.terminal.buffer.active.viewportY;
    },
    text(cwd: string) {
      const index = paths.indexOf(cwd);
      const host = root.querySelectorAll<HTMLElement>(".terminal-tab-body")[index]?.querySelector(".terminal-host");
      const terminal = terminals.find((entry) => entry.host === host)?.terminal;
      if (!terminal) return "";
      const buffer = terminal.buffer.active;
      return Array.from(
        { length: buffer.length },
        (_, i) => buffer.getLine(i)?.translateToString(true) ?? "",
      ).join("\n");
    },
    complete(index: number, text = "Controlled output") {
      completions[index]?.(text);
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
      Object.assign(client, originalClient);
    },
  };
}
