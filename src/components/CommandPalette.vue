<script setup lang="ts">
// Ctrl+K: one box for commands, apps, notes, files, browser history and Git
// commits. Start with ">" to list commands only.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "./Icon.vue";
import { allCommands, requestOpen, type Command } from "../commands";
import { flatten, type CanvasApp } from "../model";
import { api, iconOf, type FileEntry } from "./files/explorer";

const props = defineProps<{ apps: CanvasApp[]; initial?: string }>();
const emit = defineEmits<{ close: []; focusApp: [appId: string]; focusBlock: [blockId: string] }>();
type Result = { key: string; section: string; title: string; detail?: string; icon: string; hint?: string; run: () => unknown };
const query = ref(props.initial ?? "");
const input = ref<HTMLInputElement>();
const list = ref<HTMLElement>();
const active = ref(0);
const commandsOnly = computed(() => query.value.startsWith(">"));
const text = computed(() => query.value.replace(/^>\s*/, "").trim().toLowerCase());
// Every word must appear somewhere; earlier and title matches rank higher.
function score(haystack: string, title: string) {
  const words = text.value.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const h = haystack.toLowerCase(),
    t = title.toLowerCase();
  let total = 0;
  for (const word of words) {
    const at = h.indexOf(word);
    if (at < 0) return 0;
    total += (t.startsWith(word) ? 6 : t.includes(word) ? 4 : 1) + (at === 0 ? 1 : 0);
  }
  return total;
}
const appName = (blockId?: string) =>
  blockId ? props.apps.find((a) => flatten(a.blocks).some((b) => b.id === blockId))?.name : undefined;
function blockApp(kind: string) {
  for (const app of props.apps) {
    if (app.archived || app.deleted) continue;
    const block = flatten(app.blocks).find((b) => b.kind === kind);
    if (block) return { app, block };
  }
  return null;
}

// ---- Synchronous sources: commands, apps, browser history ----
const commandResults = computed<Result[]>(() =>
  allCommands()
    .map((c: Command) => ({ c, s: score(`${c.title} ${c.detail ?? ""} ${c.keywords ?? ""}`, c.title) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, text.value ? 12 : 30)
    .map(({ c }) => ({
      key: `cmd:${c.id}`,
      section: "Commands",
      title: c.title,
      detail: c.detail ?? appName(c.blockId),
      icon: c.icon,
      hint: c.hint,
      run: () => {
        if (c.blockId) emit("focusBlock", c.blockId);
        return c.run();
      },
    })),
);
const appResults = computed<Result[]>(() =>
  commandsOnly.value
    ? []
    : props.apps
        .filter((a) => !a.archived && !a.deleted)
        .map((a) => ({ a, s: score(`${a.name} ${a.group}`, a.name || "Untitled") }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, text.value ? 8 : 6)
        .map(({ a }) => ({
          key: `app:${a.id}`,
          section: "Apps",
          title: a.name || "Untitled",
          detail: a.group || undefined,
          icon: a.icon || "app",
          run: () => emit("focusApp", a.id),
        })),
);
const historyResults = computed<Result[]>(() => {
  if (commandsOnly.value || text.value.length < 2) return [];
  const out: Result[] = [];
  const seen = new Set<string>();
  for (const app of props.apps) {
    if (app.archived || app.deleted) continue;
    for (const block of flatten(app.blocks)) {
      if (block.kind !== "browser") continue;
      let pages: { url: string; title?: string }[] = [];
      try {
        pages = JSON.parse(block.value || "{}").recentPages ?? [];
      } catch {
        continue;
      }
      for (const page of pages) {
        if (!page?.url || seen.has(page.url) || !score(`${page.title ?? ""} ${page.url}`, page.title ?? "")) continue;
        seen.add(page.url);
        out.push({
          key: `web:${page.url}`,
          section: "Browser history",
          title: page.title || page.url,
          detail: page.url,
          icon: "globe",
          run: () => {
            emit("focusBlock", block.id);
            requestOpen({ kind: "browser-url", blockId: block.id, url: page.url });
          },
        });
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
});

// ---- Asynchronous sources: notes, files, Git (debounced) ----
const notes = shallowRef<Result[]>([]);
const files = shallowRef<Result[]>([]);
const commits = shallowRef<Result[]>([]);
const searching = ref(0);
let notesCache: { at: number; pages: { id: string; title: string; trashedAt: string | null; icon: string | null }[]; blocks: { pageId: string; html: string }[] } | null = null;
async function notesData() {
  if (notesCache && Date.now() - notesCache.at < 15_000) return notesCache;
  const post = (collection: string) =>
    fetch("/__orvane/notes/data", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collection, action: "list" }),
    }).then((r) => (r.ok ? r.json() : []));
  const [pages, blocks] = await Promise.all([post("pages"), post("blocks")]);
  notesCache = { at: Date.now(), pages: Array.isArray(pages) ? pages : [], blocks: Array.isArray(blocks) ? blocks : [] };
  return notesCache;
}
const plain = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
async function searchNotes(q: string) {
  const target = blockApp("notes");
  if (!target) return [];
  const data = await notesData();
  const textByPage = new Map<string, string>();
  for (const b of data.blocks) textByPage.set(b.pageId, (textByPage.get(b.pageId) ?? "") + " " + plain(b.html ?? ""));
  return data.pages
    .filter((p) => !p.trashedAt)
    .map((p) => {
      const body = textByPage.get(p.id) ?? "";
      const s = score(`${p.title} ${body}`, p.title || "Untitled");
      const at = body.toLowerCase().indexOf(q.split(/\s+/)[0]!);
      return { p, s, excerpt: at >= 0 ? body.slice(Math.max(0, at - 30), at + 70).trim() : "" };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map(({ p, excerpt }) => ({
      key: `note:${p.id}`,
      section: "Notes",
      title: `${p.icon ? p.icon + " " : ""}${p.title || "Untitled"}`,
      detail: excerpt || target.app.name,
      icon: "text",
      run: () => {
        emit("focusBlock", target.block.id);
        requestOpen({ kind: "notes-page", blockId: target.block.id, pageId: p.id });
      },
    }));
}
let roots: { home: string; places: { path: string }[] } | null = null;
// Most likely places first: folders open or pinned in File Explorers, then
// Quick access, then the rest of the home folder.
function explorerFolders() {
  const out: string[] = [];
  for (const app of props.apps)
    for (const block of flatten(app.blocks)) {
      if (block.kind !== "files") continue;
      try {
        const state = JSON.parse(block.value || "{}");
        for (const pin of state.pins ?? []) if (typeof pin === "string") out.push(pin);
        for (const pane of state.panes ?? []) if (typeof pane?.path === "string") out.push(pane.path);
      } catch {
        // No saved state yet.
      }
    }
  return out;
}
async function searchFiles(q: string) {
  roots ??= await api<{ home: string; places: { path: string }[] }>("roots");
  const order = [...explorerFolders(), ...roots.places.map((p) => p.path).filter((p) => p !== roots!.home), roots.home];
  const data = await api<{ entries: FileEntry[] }>("search", { paths: [...new Set(order)], query: q, budget: 2500, limit: 60 });
  return data.entries.slice(0, 12).map((e) => ({
    key: `file:${e.path}`,
    section: "Files",
    title: e.name,
    detail: e.path,
    icon: iconOf(e),
    run: () => openInExplorer(e),
  }));
}
function openInExplorer(entry: FileEntry) {
  const target = blockApp("files");
  const folder = entry.dir ? entry.path : entry.path.replace(/[\\/][^\\/]*$/, "");
  if (!target) {
    void api("open", { path: entry.dir ? entry.path : folder });
    return;
  }
  emit("focusBlock", target.block.id);
  requestOpen({ kind: "explorer-path", blockId: target.block.id, path: folder, select: entry.dir ? undefined : entry.path });
}
async function searchCommits(q: string) {
  const response = await fetch("/__orvane/git/git_search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  if (!response.ok) return [];
  const rows: { workspaceId: string; workspace: string; hash: string; short: string; subject: string; author: string; date: string }[] =
    await response.json();
  return rows.slice(0, 8).map((c) => ({
    key: `commit:${c.workspaceId}:${c.hash}`,
    section: "Git commits",
    title: c.subject,
    detail: `${c.short} · ${c.workspace} · ${c.author} · ${c.date.slice(0, 10)}`,
    icon: "commit",
    run: () => {
      // Prefer a Git viewer already showing that repository.
      const viewer =
        props.apps.flatMap((a) => flatten(a.blocks)).find((b) => b.kind === "git" && b.gitWorkspaceId === c.workspaceId) ??
        blockApp("git")?.block;
      if (!viewer) return void navigator.clipboard?.writeText(c.hash);
      emit("focusBlock", viewer.id);
      requestOpen({ kind: "git-commit", blockId: viewer.id, workspaceId: c.workspaceId, hash: c.hash });
    },
  }));
}
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
watch(
  text,
  (q) => {
    clearTimeout(timer);
    const id = ++seq;
    if (commandsOnly.value || q.length < 2) {
      notes.value = files.value = commits.value = [];
      return;
    }
    timer = setTimeout(() => {
      const run = (source: (q: string) => Promise<Result[]>, into: typeof notes, min = 2) => {
        if (q.length < min) return void (into.value = []);
        searching.value++;
        source(q)
          .then((r) => id === seq && (into.value = r))
          .catch(() => id === seq && (into.value = []))
          .finally(() => searching.value--);
      };
      run(searchNotes, notes);
      run(searchCommits, commits, 3);
      run(searchFiles, files, 2);
    }, 180);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

const results = computed(() => [
  ...appResults.value,
  ...commandResults.value,
  ...notes.value,
  ...historyResults.value,
  ...commits.value,
  ...files.value,
]);
const sections = computed(() => {
  const out: { name: string; items: { result: Result; index: number }[] }[] = [];
  results.value.forEach((result, index) => {
    let section = out.find((s) => s.name === result.section);
    if (!section) out.push((section = { name: result.section, items: [] }));
    section.items.push({ result, index });
  });
  return out;
});
watch(results, () => (active.value = Math.min(active.value, Math.max(0, results.value.length - 1))));
watch(query, () => (active.value = 0));
function run(result?: Result) {
  if (!result) return;
  // Run while the palette is still mounted: its focusApp/focusBlock events
  // only reach the canvas from a live component. Closing comes after.
  void result.run();
  emit("close");
}
function keydown(event: KeyboardEvent) {
  event.stopPropagation();
  const count = results.value.length;
  if (event.key === "Escape") (event.preventDefault(), emit("close"));
  else if (event.key === "ArrowDown") (event.preventDefault(), (active.value = (active.value + 1) % Math.max(1, count)));
  else if (event.key === "ArrowUp") (event.preventDefault(), (active.value = (active.value - 1 + count) % Math.max(1, count)));
  else if (event.key === "Enter") (event.preventDefault(), run(results.value[active.value]));
  else return;
  void nextTick(() => list.value?.querySelector(".cp-item.active")?.scrollIntoView({ block: "nearest" }));
}
onMounted(() => void nextTick(() => input.value?.focus()));
</script>
<template>
  <div class="cp-backdrop" @pointerdown.self="emit('close')">
    <div class="cp" role="dialog" aria-label="Search and commands" @keydown="keydown">
      <div class="cp-input">
        <Icon :name="commandsOnly ? 'forward' : 'search'" :size="16" />
        <input
          ref="input"
          v-model="query"
          placeholder="Search apps, notes, files, history, commits… or type > for commands"
          aria-label="Search"
          spellcheck="false"
          autocomplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="cp-results"
          :aria-activedescendant="results[active] ? `cp-${active}` : undefined"
        />
        <span v-if="searching" class="cp-spinner" aria-label="Searching" />
        <kbd>Esc</kbd>
      </div>
      <div id="cp-results" ref="list" class="cp-results" role="listbox">
        <template v-for="section in sections" :key="section.name">
          <p class="cp-section">{{ section.name }}</p>
          <button
            v-for="{ result, index } in section.items"
            :id="`cp-${index}`"
            :key="result.key"
            class="cp-item"
            :class="{ active: index === active }"
            role="option"
            :aria-selected="index === active"
            @pointermove="active = index"
            @click="run(result)"
          >
            <Icon :name="result.icon" :size="15" />
            <span class="cp-title">{{ result.title }}</span>
            <span v-if="result.detail" class="cp-detail">{{ result.detail }}</span>
            <kbd v-if="result.hint">{{ result.hint }}</kbd>
          </button>
        </template>
        <p v-if="!results.length && !searching" class="cp-empty">Nothing found.</p>
      </div>
      <div class="cp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>&gt;</kbd> commands</span>
      </div>
    </div>
  </div>
</template>
<style scoped>
.cp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
  background: rgb(79 104 121 / 12%);
  animation: cp-fade 0.14s ease;
}
.cp {
  display: flex;
  flex-direction: column;
  width: min(640px, calc(100vw - 32px));
  max-height: 70vh;
  border-radius: 10px;
  background: #f7f9fa;
  box-shadow:
    0 24px 60px rgb(39 63 78 / 22%),
    0 4px 14px rgb(39 63 78 / 10%);
  overflow: hidden;
  animation: cp-in 0.16s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.cp-input {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #e2eaee;
  color: #718591;
}
.cp-input input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: #2f4856;
  font: inherit;
  font-size: 15px;
  outline: none;
}
kbd {
  padding: 1px 5px;
  border: 1px solid #dce5e9;
  border-radius: 4px;
  background: #fff;
  color: #718591;
  font: inherit;
  font-size: 10px;
}
.cp-results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 6px 8px;
}
.cp-section {
  margin: 8px 8px 3px;
  color: #8798a3;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.cp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 6px;
  background: none;
  color: #455968;
  font-size: 13px;
  text-align: left;
}
.cp-item.active {
  background: #dce9f0;
  color: #2f4856;
}
.cp-title {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #8798a3;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cp-item kbd {
  margin-left: auto;
}
.cp-empty {
  margin: 0;
  padding: 18px;
  color: #8798a3;
  text-align: center;
  font-size: 12px;
}
.cp-foot {
  display: flex;
  gap: 14px;
  padding: 6px 14px;
  border-top: 1px solid #e2eaee;
  color: #8798a3;
  font-size: 11px;
}
.cp-foot kbd {
  margin-right: 3px;
}
.cp-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #c7d6dd;
  border-top-color: #557a8e;
  border-radius: 50%;
  animation: cp-spin 0.8s linear infinite;
}
@keyframes cp-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes cp-fade {
  from {
    opacity: 0;
  }
}
@keyframes cp-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.99);
  }
}
@media (prefers-reduced-motion: reduce) {
  .cp-backdrop,
  .cp {
    animation: none;
  }
}
</style>
