<script lang="ts">
import type { Terminal as Xterm } from "@xterm/xterm";
import type { FitAddon as Fit } from "@xterm/addon-fit";
// Live xterms of panes that just unmounted, shared by every pane. A pane moved
// in the split layout picks its own back up when it mounts again.
const moving = new Map<string, { term: Xterm; fit: Fit; exited: boolean; timer: ReturnType<typeof setTimeout> }>();
</script>

<script setup lang="ts">
// One terminal pane: xterm.js bound to a live shell on the local server.
// Output streams as it happens; the shell keeps running across reloads.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { OutputHold } from "../../terminalHold";
import { Terminal, type IDisposable, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminal as client, type SessionListener } from "../../terminalClient";
import { DRAG_MIME } from "../files/explorer";
import { registerAppText } from "../../appText";
import { TERMINAL } from "./controller";
import Icon from "../Icon.vue";
import { TERMINAL_DARK } from "../../terminalTint";
import type { PaneNode } from "../../terminalLayout";

const props = defineProps<{ pane: PaneNode; movable?: boolean; resizing?: boolean; dropEdge?: "left" | "right" | "top" | "bottom" }>();
const ctl = inject(TERMINAL)!;
const terminalFont = '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace';
const powerShell = computed(() => ctl.profileOf(props.pane.profile)?.kind === "powershell");
const inputOffsetProperty = "--terminal-input-offset";
const host = ref<HTMLDivElement>();
// Selected text and the latest output, for Agent sessions (Ctrl+Shift+L,
// app snapshots). xterm draws on a canvas, so the DOM has no text to read.
let stopAppText: (() => void) | undefined;
onMounted(() => {
  if (!host.value) return;
  stopAppText = registerAppText(host.value, {
    selection: () => term?.getSelection() ?? "",
    text: () => {
      const buffer = term?.buffer.active;
      if (!buffer) return "";
      const lines: string[] = [];
      const end = buffer.baseY + buffer.cursorY;
      for (let y = Math.max(0, end - 120); y <= end; y++)
        lines.push(buffer.getLine(y)?.translateToString(true) ?? "");
      return lines.join("\n").replace(/\n+$/, "");
    },
  });
});
onBeforeUnmount(() => stopAppText?.());
const dropping = ref(false);
const hasScrollback = ref(false);
let term: Terminal | undefined;
let fit: FitAddon | undefined;
let exited = false;
let observer: ResizeObserver | undefined;
let fitFrame = 0;
let fitted = { width: 0, height: 0, fontSize: 0 };
let subscriptions: IDisposable[] = [];

// Match the pane surface so xterm can calculate contrast for ANSI reverse video.
const theme = {
  background: "#f7f9fa",
  foreground: "#2b3a44",
  cursor: "#45697e",
  cursorAccent: "#f7fafc",
  selectionBackground: "#c5d8e3",
  selectionInactiveBackground: "#d9e4eb",
  selectionForeground: "#223744",
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
const dark = inject(TERMINAL_DARK, ref(false));
const darkTheme = {
  ...theme,
  background: "#18242c", foreground: "#dfe8ed",
  cursor: "#9cc4dc", cursorAccent: "#18242c",
  selectionBackground: "#456477", selectionInactiveBackground: "#344b59", selectionForeground: "#ffffff",
  scrollbarSliderBackground: "rgba(169,187,198,0.3)",
  scrollbarSliderHoverBackground: "rgba(169,187,198,0.42)",
  scrollbarSliderActiveBackground: "rgba(169,187,198,0.52)",
  black: "#18242c", red: "#f0a49c", green: "#8fd6a8", yellow: "#e3c77c",
  blue: "#9cc4dc", magenta: "#c7a4d5", cyan: "#8dd4d8", white: "#dfe8ed",
  brightBlack: "#a3b5c0", brightRed: "#ffc0b8", brightGreen: "#adf0c5", brightYellow: "#f5dfa1",
  brightBlue: "#b8ddf3", brightMagenta: "#e0bfee", brightCyan: "#adedef", brightWhite: "#ffffff",
};
watch(dark, (value) => { if (term) term.options.theme = value ? darkTheme : theme; });

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
    const scale = (element.offsetWidth && rect.width / element.offsetWidth) || 1;
    const offset = parseFloat(t.element?.closest<HTMLElement>(".terminal-scroll")
      ?.style.getPropertyValue(inputOffsetProperty) ?? "") || 0;
    const inputRow = offset && t.element?.querySelector(".xterm-cursor")?.parentElement?.getBoundingClientRect();
    const shift = inputRow && event.clientY >= inputRow.top && event.clientY < inputRow.bottom ? offset : 0;
    if (!shift && Math.abs(scale - 1) < 0.001) return event;
    const clientX = rect.left + (event.clientX - rect.left) / scale - shift,
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
  if (props.resizing) return;
  const width = host.value?.offsetWidth ?? 0;
  const height = host.value?.offsetHeight ?? 0;
  if (!term || !fit || !width || !height) return;
  const fontSize = ctl.fontSize.value;
  if (width === fitted.width && height === fitted.height && fontSize === fitted.fontSize) return;
  try {
    fit.fit();
    fitted = { width, height, fontSize };
  } catch {
    // Not laid out yet.
  }
}
function syncScrollback() {
  hasScrollback.value = (term?.buffer.active.baseY ?? 0) > 0;
}
function start() {
  if (!term) return;
  exited = false;
  client.open(
    props.pane.id,
    { profile: props.pane.profile, cwd: props.pane.cwd, cols: term.cols, rows: term.rows },
    sessionListener(),
  );
}
// Panned off screen on the canvas, output is held and written in one go when
// the pane is seen again (see terminalHold.ts).
const hold = new OutputHold((data) => term?.write(data));
let visibility: IntersectionObserver | undefined;
const writeHeld = () => hold.release();
function sessionListener(): SessionListener {
  return {
      started() {
        // A fresh shell: anything shown before belongs to an old one.
        if (term?.buffer.active.length && term.buffer.active.length > term.rows) term.write("\r\n");
      },
      attached(replay) {
        hold.discard();
        term?.reset();
        term?.write(replay);
      },
      pin(path) {
        ctl.pinFolder(props.pane.id, path);
      },
      cwd(path) {
        ctl.folder(props.pane.id, path);
      },
      output(data) {
        hold.output(data);
        if (!ctl.visible(props.pane.id)) ctl.activity(props.pane.id);
      },
      exit(code) {
        writeHeld();
        exited = true;
        if (code === 0 && ctl.closeAfterExit(props.pane.id)) return;
        term?.write(`\r\n\x1b[90m[Process exited with code ${code}. Press Enter to restart.]\x1b[0m\r\n`);
      },
      error(message) {
        writeHeld();
        exited = true;
        term?.write(`\r\n\x1b[31m${message}\x1b[0m\r\n\x1b[90m[Press Enter to try again.]\x1b[0m\r\n`);
      },
  };
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
  writeHeld();
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

// Bind this component to the xterm: every handler that reads component state.
function wire(t: Terminal) {
  const scroller = host.value!.parentElement!;
  const screen = t.element!.querySelector<HTMLElement>(".xterm-screen")!;
  function positionInputLine() {
    if (!powerShell.value || t.buffer.active.type !== "normal") {
      scroller.style.removeProperty(inputOffsetProperty);
      return;
    }
    const width = scroller.clientWidth;
    const caretEnd = (t.buffer.active.cursorX + 1) * screen.offsetWidth / t.cols;
    const inputScroll = Math.max(0, Math.ceil(caretEnd - width));
    // Keep output at the chosen scroll position. The active line only pans
    // when its own caret would move beyond the right edge of the pane.
    const offset = width ? scroller.scrollLeft - inputScroll : 0;
    scroller.style.setProperty(inputOffsetProperty, `${offset}px`);
  }
  scroller.addEventListener("scroll", positionInputLine, { passive: true });
  const focusOwner = () => ctl.focus(props.pane.id);
  t.textarea?.addEventListener("focus", focusOwner);
  t.attachCustomKeyEventHandler(keys);
  subscriptions = [
    t.registerLinkProvider({ provideLinks }),
    t.onData((data) => {
      if (exited) {
        if (data === "\r") start();
        return;
      }
      client.input(props.pane.id, data);
    }),
    t.onResize(({ cols, rows }) => {
      client.resize(props.pane.id, cols, rows);
      syncScrollback();
    }),
    t.onWriteParsed(syncScrollback),
    t.onScroll(syncScrollback),
    t.onRender(positionInputLine),
    t.buffer.onBufferChange(syncScrollback),
    t.onTitleChange((title) => ctl.title(props.pane.id, title)),
    t.onBell(() => ctl.bell(props.pane.id)),
    { dispose: () => {
      t.textarea?.removeEventListener("focus", focusOwner);
      scroller.removeEventListener("scroll", positionInputLine);
      scroller.style.removeProperty(inputOffsetProperty);
    } },
  ];
  positionInputLine();
}

onMounted(async () => {
  // A pane moved to another spot in the split layout remounts. Keep its live
  // xterm: replaying the shell's raw output into a new one redraws every
  // prompt ConPTY repainted at earlier sizes.
  const kept = moving.get(props.pane.id);
  if (kept) {
    moving.delete(props.pane.id);
    clearTimeout(kept.timer);
    ({ term, fit, exited } = kept);
    term.options.theme = dark.value ? darkTheme : theme;
    host.value!.appendChild(kept.term.element!);
    wire(term);
    client.listen(props.pane.id, sessionListener());
    syncScrollback();
  } else {
    term = new Terminal({
      // Terminal apps choose their own ANSI foreground/background pairs.
      minimumContrastRatio: 1,
      fontFamily: terminalFont,
      fontSize: ctl.fontSize.value,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "bar",
      // Preserve the full current line through a narrow/wide resize cycle.
      reflowCursorLine: true,
      scrollback: 10000,
      theme: dark.value ? darkTheme : theme,
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.value!);
    followCanvasZoom(term);
    wire(term);
  }
  await nextTick();
  if (!term || !host.value) return;
  fitNow();
  if (!kept) start();
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(fitFrame);
    if (!props.resizing) fitFrame = requestAnimationFrame(fitNow);
  });
  observer.observe(host.value!);
  visibility = new IntersectionObserver(([entry]) => {
    // Only a pane that is laid out but outside the view (the canvas camera
    // moved away) holds output. A hidden tab or panel has no size and keeps
    // writing, as before, so its buffer stays current.
    const rect = entry?.boundingClientRect;
    hold.visible(!entry || entry.isIntersecting || !rect?.width || !rect.height);
  });
  visibility.observe(host.value!);
  ctl.register(props.pane.id, {
    element: host.value!,
    focus: () => term?.focus(),
    find,
    clearFind,
    copy: () => void copy(),
    paste: () => void paste(),
    clear: () => {
      writeHeld();
      term?.clear();
    },
    restart: start,
  });
  if (ctl.focused(props.pane.id) && ctl.visible(props.pane.id)) term.focus();
});
// ConPTY repaints on resize. Fit once after the divider's final layout so
// the next shell input uses the new size without a timer.
watch(() => props.resizing, (resizing) => {
  if (!resizing) fitNow();
}, { flush: "post" });
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
  cancelAnimationFrame(fitFrame);
  observer?.disconnect();
  visibility?.disconnect();
  // A remount (moved in the split layout) keeps this xterm: give it everything.
  writeHeld();
  ctl.register(props.pane.id, null);
  for (const subscription of subscriptions) subscription.dispose();
  subscriptions = [];
  if (term && fit) {
    // Wait a moment in case the pane remounts elsewhere in the layout.
    const id = props.pane.id;
    const parked = { term, fit, exited };
    moving.set(id, {
      ...parked,
      timer: setTimeout(() => {
        if (moving.get(id)?.term !== parked.term) return;
        moving.delete(id);
        // Unmounting (closing Orvane, archiving the app) leaves the shell running;
        // closing the pane itself kills it (TerminalView does that).
        client.detach(id);
        parked.term.dispose();
      }),
    });
  }
  term = undefined;
  fit = undefined;
});
</script>

<template>
  <div
    class="terminal-pane"
    :data-terminal-pane="pane.id"
    :class="{ focused: ctl.focused(pane.id), dropping, 'has-pane-handle': movable, 'has-scrollback': hasScrollback }"
    @pointerdown="ctl.focus(pane.id)"
    @contextmenu="contextMenu"
    @keydown.esc.stop
    @dragover="dragOver"
    @dragleave="dropping = false"
    @drop="drop"
  >
    <div class="terminal-scroll" :class="{ powershell: powerShell }">
      <div ref="host" class="terminal-host"
        :style="powerShell ? { fontFamily: terminalFont, fontSize: ctl.fontSize.value + 'px' } : undefined"></div>
    </div>
    <div v-if="movable" class="terminal-pane-controls">
      <button type="button" class="terminal-pane-handle" :data-drag-terminal-pane="pane.id"
        aria-label="Drag pane" title="Drag pane to reposition it · Shift-drag from inside the pane">
        <Icon name="grip" :size="13" />
      </button>
      <button type="button" :data-untile-terminal-pane="pane.id"
        aria-label="Move pane to its own tab" title="Move pane to its own tab">
        <Icon name="external" :size="12" />
      </button>
      <button type="button" aria-label="Close pane" title="Close pane (Ctrl+Shift+W)"
        @pointerdown.left.stop @click.stop="ctl.command('close-pane', pane.id)">
        <Icon name="close" :size="12" />
      </button>
    </div>
    <Transition name="terminal-tile">
      <div v-if="dropEdge" class="terminal-pane-drop" :class="dropEdge" aria-hidden="true"></div>
    </Transition>
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
.terminal-pane.has-pane-handle { padding-top: 23px; }
.terminal-pane-controls {
  position: absolute;
  top: 3px;
  right: 5px;
  display: flex;
  gap: 3px;
}
.terminal-pane-controls button {
  display: grid;
  place-items: center;
  width: 24px;
  height: 17px;
  border: 0;
  padding: 0;
  color: #455968;
  background: #e9eff3;
  border-radius: 4px;
  cursor: pointer;
}
.terminal-pane-controls button:hover { background: #dbe8ee; }
.terminal-pane-controls .terminal-pane-handle {
  cursor: grab;
  touch-action: none;
}
.terminal-pane-controls .terminal-pane-handle:active { cursor: grabbing; }
.terminal-pane-drop {
  position: absolute;
  inset: 3px;
  border: 2px solid #546e7c;
  border-radius: 5px;
  background: rgb(197 216 227 / 65%);
  pointer-events: none;
  z-index: 2;
}
.terminal-pane-drop.left { right: 50%; }
.terminal-pane-drop.right { left: 50%; }
.terminal-pane-drop.top { bottom: 50%; }
.terminal-pane-drop.bottom { top: 50%; }
.terminal-tile-enter-active, .terminal-tile-leave-active {
  transition: opacity 120ms ease-out;
}
.terminal-tile-enter-from, .terminal-tile-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .terminal-tile-enter-active, .terminal-tile-leave-active { transition: none; }
}
.terminal-scroll,
.terminal-host {
  width: 100%;
  height: 100%;
  /* Keep the previous xterm grid inside the pane while the divider is held. */
  overflow: clip;
}
.terminal-scroll.powershell {
  overflow: auto hidden;
}
/* PowerShell may omit table columns entirely at small console widths.
   Keep a standard 80-column grid plus xterm's 14px scrollbar allowance. */
.terminal-scroll.powershell > .terminal-host {
  min-width: calc(80ch + 14px);
}
.terminal-scroll.powershell :deep(.xterm-rows > div:has(.xterm-cursor)) {
  /* The translation isolates the row. Keep it above xterm's z-index 1 selection. */
  position: relative;
  z-index: 2;
  translate: var(--terminal-input-offset, 0px) 0;
}
/* Composite the character grid together to avoid row seams when zoomed out. */
.terminal-host :deep(.xterm-screen) {
  will-change: transform;
}
/* Chromium can antialias the edges of adjacent ANSI backgrounds separately.
   Back each painted run up by one pixel so the canvas cannot show through. */
.terminal-host :deep(.xterm-rows > div) {
  overflow: clip !important;
  overflow-clip-margin: 1px;
}
.terminal-host :deep(.xterm-rows span:is([style*="background-color"], [class*="xterm-bg-"])) {
  position: relative;
  isolation: isolate;
}
.terminal-host :deep(.xterm-rows span:is([style*="background-color"], [class*="xterm-bg-"])::before) {
  content: "";
  position: absolute;
  inset: -1px 0 0;
  background-color: inherit;
  z-index: -1;
}
/* Orvane's frosted glass shows through. The theme stays opaque so xterm can
   keep highlighted and reverse-video text readable; only the painted
   background (xterm sets it inline on its scroll container) is cleared. */
.terminal-host :deep(.xterm),
.terminal-host :deep(.xterm-viewport),
.terminal-host :deep(.xterm-scrollable-element) {
  background: transparent !important;
}
/* xterm draws its own scrollbar; a native one here added a second bar with
   Windows' arrow buttons. */
.terminal-host :deep(.xterm-viewport) {
  scrollbar-width: none;
}
/* Xterm's thumb uses pixel geometry. The buffer decides whether rows can scroll. */
.terminal-pane:not(.has-scrollback) :deep(.xterm-scrollable-element > .scrollbar.vertical) {
  display: none;
}
</style>
