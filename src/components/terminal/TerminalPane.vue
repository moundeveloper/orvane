<script setup lang="ts">
// One terminal pane: xterm.js bound to a live shell on the local server.
// Output streams as it happens; the shell keeps running across reloads.
import { inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminal as client } from "../../terminalClient";
import { DRAG_MIME } from "../files/explorer";
import { TERMINAL } from "./controller";
import type { PaneNode } from "../../terminalLayout";

const props = defineProps<{ pane: PaneNode }>();
const ctl = inject(TERMINAL)!;
const host = ref<HTMLDivElement>();
const dropping = ref(false);
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let exited = false;
let observer: ResizeObserver | undefined;

// Readable on Orvane's frosted glass (light, translucent background).
const theme = {
  background: "#00000000",
  foreground: "#2b3a44",
  cursor: "#45697e",
  cursorAccent: "#f7fafc",
  selectionBackground: "rgba(111, 137, 152, 0.32)",
  scrollbarSliderBackground: "rgba(69, 89, 104, 0.3)",
  scrollbarSliderHoverBackground: "rgba(69, 89, 104, 0.42)",
  scrollbarSliderActiveBackground: "rgba(69, 89, 104, 0.52)",
  black: "#2b3a44",
  red: "#b83a35",
  green: "#2f7d4f",
  yellow: "#946b08",
  blue: "#2f67a8",
  magenta: "#8c4a95",
  cyan: "#1d7d82",
  white: "#7b8a93",
  brightBlack: "#5d6f7b",
  brightRed: "#d0453f",
  brightGreen: "#38915c",
  brightYellow: "#ad7f0c",
  brightBlue: "#3a7cc4",
  brightMagenta: "#a45bad",
  brightCyan: "#22949a",
  brightWhite: "#9aa8b0",
};

// xterm.js maps the pointer to a character cell without allowing for CSS
// scaling, and the canvas zooms apps with a transform: at any zoom but
// 100% clicks, selection and links landed on the wrong cell. Its mouse
// service (shared by selection, links and mouse reporting) gets positions
// converted back to the terminal's own unscaled pixels.
function followCanvasZoom(t: Terminal) {
  const service = (t as unknown as { _core?: { _mouseService?: Record<string, unknown> } })._core?._mouseService;
  if (!service) return;
  const unscale = (event: MouseEvent, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const scale = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    if (!scale || Math.abs(scale - 1) < 0.001) return event;
    const clientX = rect.left + (event.clientX - rect.left) / scale,
      clientY = rect.top + (event.clientY - rect.top) / scale;
    return new Proxy(event, {
      get(target, key) {
        if (key === "clientX") return clientX;
        if (key === "clientY") return clientY;
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  for (const name of ["getCoords", "getMouseReportCoords"]) {
    const original = service[name];
    if (typeof original !== "function") continue;
    service[name] = (event: MouseEvent, element: HTMLElement, ...rest: unknown[]) =>
      original.call(service, unscale(event, element), element, ...rest);
  }
}
function fitNow() {
  if (!term || !fit || !host.value?.offsetWidth || !host.value.offsetHeight) return;
  try {
    fit.fit();
  } catch {
    // Not laid out yet.
  }
}
function start() {
  if (!term) return;
  exited = false;
  client.open(
    props.pane.id,
    { profile: props.pane.profile, cwd: props.pane.cwd, cols: term.cols, rows: term.rows },
    {
      started() {
        // A fresh shell: anything shown before belongs to an old one.
        if (term?.buffer.active.length && term.buffer.active.length > term.rows) term.write("\r\n");
      },
      attached(replay) {
        term?.reset();
        term?.write(replay);
      },
      output(data) {
        term?.write(data);
        if (!ctl.visible(props.pane.id)) ctl.activity(props.pane.id);
      },
      exit(code) {
        exited = true;
        if (code === 0) return ctl.closed(props.pane.id);
        term?.write(`\r\n\x1b[90m[Process exited with code ${code}. Press Enter to restart.]\x1b[0m\r\n`);
      },
      error(message) {
        exited = true;
        term?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n\x1b[90m[Press Enter to try again.]\x1b[0m\r\n`);
      },
    },
  );
}

// ---- Clipboard (Windows Terminal conventions) ----
function copy() {
  const text = term?.getSelection();
  if (!text) return false;
  void navigator.clipboard.writeText(text).catch(() => undefined);
  term?.clearSelection();
  return true;
}
async function paste() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term?.paste(text);
  } catch {
    // No clipboard access; Ctrl+V still pastes.
  }
  term?.focus();
}
function contextMenu(event: MouseEvent) {
  event.preventDefault();
  if (!copy()) void paste();
}

// ---- Keys: terminal shortcuts, the rest goes to the shell ----
const SHORTCUTS: Record<string, string> = {
  "ctrl+shift+t": "new-tab",
  "ctrl+shift+w": "close-pane",
  "ctrl+tab": "next-tab",
  "ctrl+shift+tab": "previous-tab",
  "alt+shift+d": "split-auto",
  "alt+shift+=": "split-right",
  "alt+shift++": "split-right",
  "alt+shift+-": "split-down",
  "alt+shift+_": "split-down",
  "alt+arrowleft": "focus-left",
  "alt+arrowright": "focus-right",
  "alt+arrowup": "focus-up",
  "alt+arrowdown": "focus-down",
  "ctrl+shift+f": "find",
  "ctrl+=": "font-bigger",
  "ctrl++": "font-bigger",
  "ctrl+-": "font-smaller",
  "ctrl+0": "font-reset",
  "ctrl+shift+k": "clear",
};
function keyName(e: KeyboardEvent) {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  return `${e.ctrlKey || e.metaKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}${key}`;
}
function keys(e: KeyboardEvent) {
  if (e.type !== "keydown") return true;
  const name = keyName(e);
  if (name === "ctrl+c" && term?.hasSelection()) {
    copy();
    return false;
  }
  if (name === "ctrl+shift+c") {
    copy();
    e.preventDefault();
    return false;
  }
  // Ctrl+V and Ctrl+Shift+V paste through the browser's own paste event.
  if (name === "ctrl+v" || name === "ctrl+shift+v") return false;
  // Ctrl+Shift+1…9: a new tab with that profile.
  if (e.ctrlKey && e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
    e.preventDefault();
    ctl.command(`profile-${e.code.slice(5)}`, props.pane.id);
    return false;
  }
  const command = SHORTCUTS[name];
  if (!command) return true;
  e.preventDefault();
  ctl.command(command, props.pane.id);
  return false;
}

// ---- Links: Ctrl+click opens web pages in the Browser app and paths in
// the File Explorer (like Windows Terminal) ----
const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/g;
const PATH_RE = /\b[A-Za-z]:\\[^\s"'<>|*?]*[^\s"'<>|*?.,;:)\]}]/g;
function openLink(text: string) {
  const page = /^https?:/i.test(text);
  const folder = !page && (/[\\/]$/.test(text) || !/\.[\w-]{1,8}$/.test(text));
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: {
        link: {
          kind: page ? "page" : folder ? "folder" : "file",
          target: page ? text : text.replace(/[\\/]+$/, "") || text,
          label: text,
        },
        external: page,
      },
    }),
  );
}
function provideLinks(y: number, callback: (links: ILink[] | undefined) => void) {
  const line = term?.buffer.active.getLine(y - 1)?.translateToString(true);
  if (!line) return callback(undefined);
  const links: ILink[] = [];
  for (const re of [URL_RE, PATH_RE])
    for (const match of line.matchAll(re)) {
      const text = match[0].replace(/[.,;:)\]}]+$/, "");
      const start = (match.index ?? 0) + 1;
      links.push({
        range: { start: { x: start, y }, end: { x: start + text.length - 1, y } },
        text,
        decorations: { underline: true, pointerCursor: true },
        activate: (event) => {
          if (event.ctrlKey || event.metaKey) openLink(text);
        },
      });
    }
  callback(links.length ? links : undefined);
}

// ---- Search in the scrollback ----
let lastFind: { row: number; col: number; needle: string } | null = null;
function find(query: string, options: { caseSensitive: boolean; backwards: boolean }) {
  if (!term || !query) return false;
  const buffer = term.buffer.active;
  const total = buffer.length;
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const text = (row: number) => {
    const line = buffer.getLine(row)?.translateToString(true) ?? "";
    return options.caseSensitive ? line : line.toLowerCase();
  };
  // Continue from the last match, or start from what is on screen.
  let row: number, col: number;
  if (lastFind && lastFind.needle === needle) {
    row = lastFind.row;
    col = options.backwards ? lastFind.col - 1 : lastFind.col + 1;
  } else {
    row = options.backwards ? buffer.viewportY + term.rows - 1 : buffer.viewportY;
    col = options.backwards ? Infinity : 0;
  }
  for (let step = 0; step <= total; step++) {
    const r = ((options.backwards ? row - step : row + step) % total + total) % total;
    if (step === 0 && options.backwards && col < 0) continue;
    const c = options.backwards
      ? text(r).lastIndexOf(needle, step === 0 ? col : Infinity)
      : text(r).indexOf(needle, step === 0 ? col : 0);
    if (c < 0) continue;
    lastFind = { row: r, col: c, needle };
    term.select(c, r, query.length);
    term.scrollToLine(Math.max(0, r - Math.floor(term.rows / 2)));
    return true;
  }
  return false;
}
function clearFind() {
  lastFind = null;
  term?.clearSelection();
}

// ---- Dropping files pastes their quoted paths ----
function dragOver(event: DragEvent) {
  const types = event.dataTransfer?.types ?? [];
  if (!types.includes(DRAG_MIME) && !types.includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
  dropping.value = true;
}
function drop(event: DragEvent) {
  dropping.value = false;
  const data = event.dataTransfer;
  if (!data) return;
  let paths: string[] = [];
  if (data.types.includes(DRAG_MIME)) {
    try {
      paths = (JSON.parse(data.getData(DRAG_MIME)) as { paths?: string[] }).paths ?? [];
    } catch {
      paths = [];
    }
  } else {
    const desktop = (window as { orvaneDesktop?: { pathForFile?: (f: File) => string } }).orvaneDesktop;
    paths = [...data.files].map((f) => desktop?.pathForFile?.(f) ?? "").filter(Boolean);
  }
  if (!paths.length) return;
  event.preventDefault();
  event.stopPropagation();
  term?.paste(paths.map((p) => (/[\s&()^%!'"]/.test(p) ? `"${p}"` : p)).join(" "));
  term?.focus();
}

onMounted(async () => {
  term = new Terminal({
    allowTransparency: true,
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
    fontSize: ctl.fontSize.value,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 10000,
    theme,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host.value!);
  followCanvasZoom(term);
  term.attachCustomKeyEventHandler(keys);
  term.registerLinkProvider({ provideLinks });
  term.onData((data) => {
    if (exited) {
      if (data === "\r") start();
      return;
    }
    client.input(props.pane.id, data);
  });
  term.onResize(({ cols, rows }) => client.resize(props.pane.id, cols, rows));
  term.onTitleChange((title) => ctl.title(props.pane.id, title));
  term.onBell(() => ctl.bell(props.pane.id));
  term.textarea?.addEventListener("focus", () => ctl.focus(props.pane.id));
  await nextTick();
  fitNow();
  start();
  let frame = 0;
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fitNow);
  });
  observer.observe(host.value!);
  ctl.register(props.pane.id, {
    element: host.value!,
    focus: () => term?.focus(),
    find,
    clearFind,
    copy: () => void copy(),
    paste: () => void paste(),
    clear: () => term?.clear(),
    restart: start,
  });
  if (ctl.focused(props.pane.id) && ctl.visible(props.pane.id)) term.focus();
});
watch(ctl.fontSize, (size) => {
  if (!term) return;
  term.options.fontSize = size;
  fitNow();
});
// Hidden tabs have no size; fit when the tab comes back.
watch(
  () => ctl.visible(props.pane.id),
  (visible) => visible && void nextTick(fitNow),
);
onBeforeUnmount(() => {
  observer?.disconnect();
  ctl.register(props.pane.id, null);
  // Unmounting (closing Orvane, archiving the app) leaves the shell running;
  // closing the pane itself kills it (TerminalView does that).
  client.detach(props.pane.id);
  term?.dispose();
});
</script>

<template>
  <div
    class="terminal-pane"
    :class="{ focused: ctl.focused(pane.id), dropping }"
    @pointerdown="ctl.focus(pane.id)"
    @contextmenu="contextMenu"
    @keydown.esc.stop
    @dragover="dragOver"
    @dragleave="dropping = false"
    @drop="drop"
  >
    <div ref="host" class="terminal-host"></div>
  </div>
</template>

<style scoped>
.terminal-pane {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 8px 4px 4px 10px;
  border-radius: 6px;
  box-shadow: inset 0 0 0 1px transparent;
}
.terminal-pane.focused {
  box-shadow: inset 0 0 0 1px rgb(111 137 152 / 22%);
}
.terminal-pane.dropping {
  box-shadow: inset 0 0 0 2px #6f9ab0;
}
.terminal-host {
  width: 100%;
  height: 100%;
}
.terminal-host :deep(.xterm),
.terminal-host :deep(.xterm-viewport) {
  background: transparent !important;
}
/* xterm draws its own scrollbar; a native one here added a second bar with
   Windows' arrow buttons. */
.terminal-host :deep(.xterm-viewport) {
  scrollbar-width: none;
}
</style>
