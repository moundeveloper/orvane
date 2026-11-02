<script setup lang="ts">
import {
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "@lucide/vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
import type { TerminalState } from "./types";

type CommandResult = {
  stdOut: string;
  stdErr: string;
  exitCode: number;
};

type TerminalTab = {
  id: string;
  title: string;
  cwd: string;
  input: string;
  history: string[];
  historyIndex: number;
  terminal?: Terminal;
  fitAddon?: FitAddon;
};

const props = defineProps<{
  initialCwd: string;
  runCommand: (cwd: string, command: string) => Promise<CommandResult>;
  state?: TerminalState;
}>();

const emit = defineEmits<{
  stateChange: [state: TerminalState];
}>();

const isOpen = ref(true);
const isMaximized = ref(false);
const height = ref(230);
const previousHeight = ref(230);
const isResizing = ref(false);
const activeTabId = ref("");
const tabs = ref<TerminalTab[]>([]);
const terminalHosts = new Map<string, HTMLElement>();
const panelStyle = computed(() =>
  isMaximized.value ? undefined : { height: `${height.value}px` },
);
let resizeObserver: ResizeObserver | null = null;
let isRestoringState = false;
const panel = ref<HTMLElement>();
let fitFrame = 0;
let disposed = false;
let stopResize: (() => void) | undefined;

const pathSeparator = (value: string) =>
  value.includes("/") && !/^[A-Za-z]:\\/.test(value) ? "/" : "\\";
const basename = (value: string) =>
  value
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || value;
const prompt = (cwd: string) => `\x1b[34m${cwd}\x1b[0m> `;
const activeTab = () => tabs.value.find((tab) => tab.id === activeTabId.value);

const saveState = () => {
  if (isRestoringState) return;
  const payload: TerminalState = {
    isOpen: isOpen.value,
    isMaximized: isMaximized.value,
    height: height.value,
    activeCwd: activeTab()?.cwd,
    tabs: tabs.value.map((tab) => ({ title: tab.title, cwd: tab.cwd })),
  };

  emit("stateChange", payload);
};

const normalizePath = (cwd: string, target: string) => {
  const trimmed = target.trim().replace(/^["']|["']$/g, "");
  if (!trimmed || trimmed === ".") return cwd;
  if (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("/")
  )
    return trimmed;

  const separator = pathSeparator(cwd);
  const parts = `${cwd.replace(/[\\/]+$/, "")}${separator}${trimmed}`.split(
    /[\\/]+/,
  );
  const resolved: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === ".." && resolved.length > 1) resolved.pop();
    else if (part !== "..") resolved.push(part);
  }

  return resolved.join(separator);
};

const writePrompt = (tab: TerminalTab) => {
  tab.terminal?.write(`\r\n${prompt(tab.cwd)}`);
};

const fitActiveTerminal = () => {
  if (disposed || fitFrame) return;
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    if (disposed || isRestoringState || !isOpen.value) return;
    // Resolve the latest selection after rendering. Hidden restored tabs keep
    // only metadata; initialized tabs keep their buffers and pending commands.
    const tab = activeTab();
    const host = tab && terminalHosts.get(tab.id);
    if (!tab || !host || !host.clientWidth || !host.clientHeight) return;
    initTerminal(tab);
    try {
      tab?.fitAddon?.fit();
    } catch {
      // xterm can reject fit before the host has layout.
    }
  });
};

const runLine = async (tab: TerminalTab, command: string) => {
  const trimmed = command.trim();

  if (!trimmed) {
    writePrompt(tab);
    return;
  }

  tab.history.push(command);
  tab.historyIndex = tab.history.length;

  if (trimmed === "clear" || trimmed === "cls") {
    tab.terminal?.clear();
    tab.terminal?.write(prompt(tab.cwd));
    return;
  }

  if (trimmed === "exit") {
    closeTab(tab.id);
    return;
  }

  if (trimmed === "pwd" || trimmed === "cd") {
    tab.terminal?.write(`\r\n${tab.cwd}`);
    writePrompt(tab);
    return;
  }

  if (trimmed.toLowerCase().startsWith("cd ")) {
    tab.cwd = normalizePath(tab.cwd, trimmed.slice(3));
    tab.title = basename(tab.cwd);
    saveState();
    writePrompt(tab);
    return;
  }

  tab.terminal?.write("\r\n");

  try {
    const result = await props.runCommand(tab.cwd, command);
    if (result.stdOut)
      tab.terminal?.write(result.stdOut.replace(/\n/g, "\r\n"));
    if (result.stdErr)
      tab.terminal?.write(
        `\x1b[31m${result.stdErr.replace(/\n/g, "\r\n")}\x1b[0m`,
      );
    if (result.exitCode !== 0)
      tab.terminal?.write(
        `\r\n\x1b[31mExited with code ${result.exitCode}\x1b[0m`,
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command failed.";
    tab.terminal?.write(`\x1b[31m${message}\x1b[0m`);
  } finally {
    writePrompt(tab);
  }
};

const redrawInput = (tab: TerminalTab) => {
  tab.terminal?.write(`\r\x1b[2K${prompt(tab.cwd)}${tab.input}`);
};

const handleData = (tab: TerminalTab, data: string) => {
  if (data === "\r") {
    const command = tab.input;
    tab.input = "";
    void runLine(tab, command);
    return;
  }

  if (data === "\u007F") {
    if (!tab.input) return;
    tab.input = tab.input.slice(0, -1);
    tab.terminal?.write("\b \b");
    return;
  }

  if (data === "\u0003") {
    tab.input = "";
    tab.terminal?.write("^C");
    writePrompt(tab);
    return;
  }

  if (data === "\x1b[A" || data === "\x1b[B") {
    if (data === "\x1b[A") tab.historyIndex = Math.max(0, tab.historyIndex - 1);
    else tab.historyIndex = Math.min(tab.history.length, tab.historyIndex + 1);
    tab.input = tab.history[tab.historyIndex] ?? "";
    redrawInput(tab);
    return;
  }

  if (data >= " ") {
    tab.input += data;
    tab.terminal?.write(data);
  }
};

const initTerminal = (tab: TerminalTab) => {
  const host = terminalHosts.get(tab.id);
  if (!host || tab.terminal) return;

  const terminal = markRaw(
    new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Cascadia Mono, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      theme: {
        background: "#f8fafc",
        foreground: "#334155",
        cursor: "#2563eb",
        selectionBackground: "#dbeafe",
      },
    }),
  );
  const fitAddon = markRaw(new FitAddon());

  terminal.loadAddon(fitAddon);
  terminal.open(host);
  terminal.onData((data) => handleData(tab, data));
  tab.terminal = terminal;
  tab.fitAddon = fitAddon;
  terminal.write(prompt(tab.cwd));
};

const createTab = (cwd: string, title = basename(cwd)): TerminalTab => ({
  id: `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  title,
  cwd,
  input: "",
  history: [],
  historyIndex: 0,
});

const addTab = async (cwd = props.initialCwd, title = basename(cwd)) => {
  if (!cwd || disposed) return;

  isOpen.value = true;
  const tab = createTab(cwd, title);
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  saveState();
  await nextTick();
  fitActiveTerminal();
};

const closeTab = (tabId: string) => {
  const index = tabs.value.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;

  const removed = tabs.value[index]!;
  removed.terminal?.dispose();
  removed.terminal = undefined;
  removed.fitAddon = undefined;
  terminalHosts.delete(tabId);
  tabs.value.splice(index, 1);

  if (activeTabId.value === tabId) {
    activeTabId.value = tabs.value[Math.max(0, index - 1)]?.id ?? "";
  }

  if (tabs.value.length === 0) isOpen.value = false;
  saveState();
  if (tabs.value.length !== 0) fitActiveTerminal();
};

const setTerminalHost = (
  tabId: string,
  element: Element | ComponentPublicInstance | null,
) => {
  if (element instanceof HTMLElement) {
    terminalHosts.set(tabId, element);
    if (tabId === activeTabId.value) fitActiveTerminal();
  } else {
    terminalHosts.delete(tabId);
  }
};

const startResize = (event: PointerEvent) => {
  stopResize?.();
  isResizing.value = true;
  const startY = event.clientY;
  const startHeight = height.value;
  const host = (event.currentTarget as HTMLElement).closest(
    ".projects-hub",
  ) as HTMLElement;
  const scale = host.getBoundingClientRect().width / host.offsetWidth;

  const move = (moveEvent: PointerEvent) => {
    height.value = Math.min(
      520,
      Math.max(150, startHeight + (startY - moveEvent.clientY) / scale),
    );
    fitActiveTerminal();
  };
  const up = () => {
    isResizing.value = false;
    saveState();
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    window.removeEventListener("blur", up);
    stopResize = undefined;
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
  window.addEventListener("blur", up);
  stopResize = up;
};

const toggleMaximize = () => {
  if (isMaximized.value) {
    isMaximized.value = false;
    height.value = previousHeight.value;
  } else {
    previousHeight.value = height.value;
    isMaximized.value = true;
  }

  saveState();
  fitActiveTerminal();
};

const setOpen = (nextOpen: boolean) => {
  isOpen.value = nextOpen;
  saveState();
  fitActiveTerminal();
};
watch(activeTabId, () => {
  saveState();
  fitActiveTerminal();
});
watch([isOpen, isMaximized, height], fitActiveTerminal, { flush: "post" });
watch(
  () => props.initialCwd,
  (cwd) => {
    if (!isRestoringState && cwd && tabs.value.length === 0)
      void addTab(cwd, basename(cwd));
  },
);

onMounted(async () => {
  const state = props.state;
  isRestoringState = true;

  if (typeof state?.height === "number") {
    height.value = Math.min(520, Math.max(150, state.height));
    previousHeight.value = height.value;
  }

  isOpen.value = state?.isOpen ?? true;
  isMaximized.value = Boolean(state?.isMaximized);

  const restoredTabs = state?.tabs?.filter((tab) => tab.cwd) ?? [];
  if (restoredTabs.length > 0) {
    tabs.value = restoredTabs.map((tab) =>
      createTab(tab.cwd, tab.title || basename(tab.cwd)),
    );

    const active = tabs.value.find((tab) => tab.cwd === state?.activeCwd);
    activeTabId.value = active?.id ?? tabs.value.at(-1)?.id ?? "";
  } else if (!state && props.initialCwd) {
    const tab = createTab(props.initialCwd);
    tabs.value = [tab];
    activeTabId.value = tab.id;
  }

  isRestoringState = false;
  saveState();
  await nextTick();
  if (disposed) return;
  resizeObserver = new ResizeObserver(fitActiveTerminal);
  if (panel.value) resizeObserver.observe(panel.value);
  fitActiveTerminal();
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(fitFrame);
  stopResize?.();
  resizeObserver?.disconnect();
  terminalHosts.clear();
  tabs.value.forEach((tab) => {
    tab.terminal?.dispose();
    tab.terminal = undefined;
    tab.fitAddon = undefined;
  });
});

defineExpose({ addTab });
</script>

<template>
  <section
    ref="panel"
    v-show="isOpen"
    class="terminal-panel"
    :class="{ maximized: isMaximized }"
    :style="panelStyle"
  >
    <div
      class="terminal-resize-handle"
      :class="{ active: isResizing }"
      @pointerdown.prevent="startResize"
    ></div>
    <div class="terminal-titlebar">
      <div class="terminal-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="terminal-tab"
          :class="{ active: tab.id === activeTabId }"
          role="tab"
          :aria-label="tab.cwd"
          @click="activeTabId = tab.id"
          @mousedown.middle.prevent="closeTab(tab.id)"
          @auxclick.prevent="$event.button === 1 && closeTab(tab.id)"
        >
          <TerminalIcon aria-hidden="true" />
          <span>{{ tab.title }}</span>
          <button
            class="terminal-tab-close"
            aria-label="Close terminal"
            @click.stop="closeTab(tab.id)"
          >
            <X aria-hidden="true" />
          </button>
        </button>
      </div>
      <div class="terminal-actions">
        <button
          class="icon-button"
          aria-label="New terminal tab"
          @click="addTab()"
        >
          <Plus aria-hidden="true" />
        </button>
        <button
          class="icon-button"
          :aria-label="isMaximized ? 'Restore terminal' : 'Maximize terminal'"
          @click="toggleMaximize"
        >
          <Minimize2 v-if="isMaximized" aria-hidden="true" />
          <Maximize2 v-else aria-hidden="true" />
        </button>
        <button
          class="icon-button"
          aria-label="Hide terminal"
          @click="setOpen(false)"
        >
          <Minus aria-hidden="true" />
        </button>
      </div>
    </div>
    <div class="terminal-body">
      <div
        v-for="tab in tabs"
        v-show="tab.id === activeTabId"
        :key="tab.id"
        :ref="(element) => setTerminalHost(tab.id, element)"
        class="terminal-host"
      ></div>
    </div>
  </section>
  <button
    v-if="!isOpen"
    class="terminal-restore"
    aria-label="Show terminal"
    @click="setOpen(true)"
  >
    <TerminalIcon aria-hidden="true" />
  </button>
</template>
