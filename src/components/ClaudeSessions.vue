<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from "vue";
import {
  claudeRequest,
  type ClaudeSession,
  type ClaudeMessage,
  type ClaudeRead,
  type VisualRecord,
} from "../exposition";
import type { Block } from "../model";
import ExpositionView from "./ExpositionView.vue";
import Icon from "./Icon.vue";
import ChatMarkdown from "./ChatMarkdown.vue";
const props = defineProps<{ block: Block }>();
const sessions = ref<ClaudeSession[]>([]),
  active = ref(""),
  search = ref(""),
  messages = ref<ClaudeMessage[]>([]),
  visuals = ref<VisualRecord[]>([]),
  before = ref<string | null>(null),
  warnings = ref<string[]>([]),
  error = ref(""),
  loading = ref(false),
  olderBusy = ref(false),
  expanded = ref<VisualRecord | null>(null),
  returnToChat = ref<HTMLButtonElement>(),
  chat = ref<HTMLElement>();
let expandTrigger: HTMLElement | null = null;
async function expand(visual: VisualRecord) {
  expandTrigger =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  expanded.value = visual;
  await nextTick();
  returnToChat.value?.focus();
}
async function collapse() {
  expanded.value = null;
  await nextTick();
  expandTrigger?.focus({ preventScroll: true });
}
let timer: ReturnType<typeof setTimeout> | undefined,
  stopped = false,
  generation = 0,
  first = true,
  ticks = 0;
try {
  active.value = JSON.parse(props.block.value || "{}").active || "";
} catch {}
const selected = computed(() =>
  sessions.value.find((s) => s.key === active.value),
);
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return sessions.value.filter(
    (s) => !query || `${s.title} ${s.project}`.toLowerCase().includes(query),
  );
});
const attachment = computed(() => {
  const map = new Map<string, VisualRecord[]>(),
    loose: VisualRecord[] = [];
  for (const v of visuals.value) {
    const m = messages.value.find((m) =>
      v.anchorId
        ? m.id === v.anchorId || m.tools.some((t) => t.id === v.anchorId)
        : m.tools.some((t) => t.visualId === v.view.id),
    );
    if (m) map.set(m.id, [...(map.get(m.id) || []), v]);
    else loose.push(v);
  }
  return { map, loose };
});
const projectName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) || path;
const time = (value: number | string) => {
  const d = new Date(value);
  return Number.isNaN(d.valueOf())
    ? ""
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
async function list() {
  const data = await claudeRequest<{ sessions: ClaudeSession[] }>("sessions");
  sessions.value = data.sessions;
  if (active.value && !data.sessions.some((s) => s.key === active.value)) {
    active.value = "";
    messages.value = [];
    visuals.value = [];
  }
}
async function read(older = false) {
  if (!active.value) return;
  const key = active.value,
    gen = generation;
  const box = chat.value,
    atBottom =
      !box || box.scrollHeight - box.scrollTop - box.clientHeight < 100,
    oldHeight = box?.scrollHeight || 0;
  const data = await claudeRequest<ClaudeRead>("read", {
    key,
    ...(older && before.value ? { before: before.value } : {}),
  });
  if (gen !== generation || key !== active.value) return;
  const fresh = new Map(data.messages.map((m) => [m.id, m]));
  messages.value = older
    ? [...data.messages, ...messages.value.filter((m) => !fresh.has(m.id))]
    : [
        ...messages.value.map((m) => fresh.get(m.id) || m),
        ...data.messages.filter(
          (m) => !messages.value.some((old) => old.id === m.id),
        ),
      ];
  if (first || older) {
    before.value = data.before;
    first = false;
  }
  visuals.value = data.visuals;
  warnings.value = data.warnings;
  error.value = "";
  if (expanded.value)
    expanded.value =
      data.visuals.find((v) => v.view.id === expanded.value!.view.id) || null;
  await nextTick();
  if (chat.value && !expanded.value) {
    if (older) chat.value.scrollTop += chat.value.scrollHeight - oldHeight;
    else if (atBottom) chat.value.scrollTop = chat.value.scrollHeight;
  }
}
async function select(key: string) {
  const selectedGeneration = ++generation;
  active.value = key;
  props.block.value = JSON.stringify({ active: key });
  messages.value = [];
  visuals.value = [];
  expanded.value = null;
  before.value = null;
  warnings.value = [];
  first = true;
  loading.value = true;
  try {
    await read();
  } catch (e) {
    if (selectedGeneration === generation)
      error.value =
        e instanceof Error ? e.message : "Session could not be opened.";
  } finally {
    if (selectedGeneration === generation) loading.value = false;
  }
}
async function older() {
  if (olderBusy.value || !before.value) return;
  olderBusy.value = true;
  try {
    await read(true);
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "Older messages could not be read.";
  } finally {
    olderBusy.value = false;
  }
}
async function poll() {
  if (stopped) return;
  try {
    if (!document.hidden) {
      if (ticks++ % 3 === 0) await list();
      if (active.value && !loading.value && !olderBusy.value) await read();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Session updates paused.";
  } finally {
    if (!stopped) timer = setTimeout(poll, 1800);
  }
}
async function refresh() {
  try {
    await list();
    if (active.value) await read();
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Refresh failed.";
  }
}
function back() {
  generation++;
  active.value = "";
  props.block.value = "";
  expanded.value = null;
}
onMounted(() => {
  void poll();
});
onBeforeUnmount(() => {
  stopped = true;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <div class="claude-app">
    <header class="cs-toolbar">
      <strong>Claude sessions</strong
      ><span class="cs-muted">Read-only mirror</span
      ><button
        type="button"
        @click="refresh"
        aria-label="Refresh Claude sessions"
      >
        <Icon name="reload" :size="14" />Refresh
      </button>
    </header>
    <p v-if="error" class="cs-error" role="alert">
      {{ error }} <button type="button" @click="refresh">Retry</button>
    </p>
    <div
      class="cs-layout"
      :class="{ 'cs-has-selection': active, 'cs-focus': expanded }"
    >
      <nav v-show="!expanded" class="cs-sidebar" aria-label="Claude sessions">
        <label class="cs-search"
          ><Icon name="search" :size="14" /><input
            v-model="search"
            type="search"
            placeholder="Find a session…"
            aria-label="Find a Claude session"
        /></label>
        <div class="cs-session-list">
          <button
            v-for="s in filtered"
            :key="s.key"
            type="button"
            class="cs-session"
            :class="{ selected: active === s.key }"
            :aria-current="active === s.key ? 'true' : undefined"
            @click="select(s.key)"
          >
            <strong :title="s.title">{{ s.title }}</strong
            ><span :title="s.project">{{ projectName(s.project) }}</span
            ><time :datetime="new Date(s.updatedAt).toISOString()">{{
              time(s.updatedAt)
            }}</time>
          </button>
          <p v-if="!filtered.length" class="cs-empty">
            {{
              search
                ? "No matching sessions."
                : "No local Claude sessions found. Open a local Code session in Claude Desktop, then refresh."
            }}
          </p>
        </div>
      </nav>
      <div v-if="active" class="cs-session-view">
        <header v-show="!expanded" class="cs-session-header">
          <button class="cs-back" type="button" @click="back">
            <Icon name="left" :size="14" />Sessions
          </button>
          <div>
            <strong>{{ selected?.title || "Claude session" }}</strong
            ><span class="cs-muted" :title="selected?.project">{{
              selected?.project
            }}</span>
          </div>
        </header>
        <div class="cs-content">
          <div
            v-show="!expanded"
            ref="chat"
            class="cs-chat"
            aria-label="Session conversation"
          >
            <button
              v-if="before"
              type="button"
              class="cs-older"
              :disabled="olderBusy"
              @click="older"
            >
              {{ olderBusy ? "Loading…" : "Load earlier messages" }}
            </button>
            <p v-if="loading" class="cs-empty" role="status">
              Reading session…
            </p>
            <p v-if="!loading && !messages.length" class="cs-empty">
              No readable conversation messages yet.
            </p>
            <p v-for="warning in warnings" :key="warning" class="cs-warning">
              {{ warning }}
            </p>
            <article
              v-for="m in messages"
              :key="m.id"
              class="cs-message"
              :class="'cs-' + m.role"
            >
              <div class="cs-message-meta">
                <strong>{{ m.role === "user" ? "You" : "Claude" }}</strong
                ><time>{{ time(m.at) }}</time>
              </div>
              <ChatMarkdown
                v-if="m.text"
                class="cs-message-text"
                :text="m.text"
              />
              <span v-if="m.truncated" class="cs-muted"
                >Message shortened for display. The transcript is
                unchanged.</span
              >
              <details v-if="m.tools.length" class="cs-tool-details">
                <summary>
                  {{ m.tools.length }} tool
                  {{ m.tools.length === 1 ? "call" : "calls" }}
                </summary>
                <div v-for="t in m.tools" :key="t.id">
                  <code>{{ t.name }}</code
                  ><span class="cs-muted">{{ t.id }}</span>
                </div>
              </details>
              <ExpositionView
                v-for="v in attachment.map.get(m.id) || []"
                :key="v.view.id"
                :visual="v"
                @expand="expand"
              />
            </article>
            <section v-if="attachment.loose.length" class="cs-loose">
              <h3>Session visuals</h3>
              <span class="cs-muted"
                >Not attached to a loaded message. Earlier messages may contain
                the tool call.</span
              ><ExpositionView
                v-for="v in attachment.loose"
                :key="v.view.id"
                :visual="v"
                @expand="expand"
              />
            </section>
          </div>
          <section
            v-if="expanded"
            class="cs-expanded"
            aria-label="Expanded explanation"
            @keydown.esc.stop="collapse"
          >
            <header>
              <strong>Explanation</strong
              ><button ref="returnToChat" type="button" @click="collapse">
                <Icon name="close" :size="14" />Back to chat
              </button>
            </header>
            <ExpositionView :visual="expanded" expanded />
          </section>
        </div>
      </div>
      <div v-else class="cs-welcome">
        <Icon name="text" :size="24" /><strong>Open a Claude session</strong>
        <p>
          Follow its conversation and explore visual explanations in the same
          place.
        </p>
        <span class="cs-muted"
          >Messages stay in Claude’s original transcript. Orvane never sends
          messages by editing it.</span
        >
      </div>
    </div>
  </div>
</template>
<style scoped>
.claude-app {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  color: #455968;
  container-type: inline-size;
  overflow: hidden;
}
.cs-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.cs-toolbar strong {
  font-weight: 500;
}
.cs-toolbar > button {
  margin-left: auto;
}
.claude-app button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.cs-toolbar button,
.cs-session-header > button,
.cs-expanded header button,
.cs-older,
.cs-error button {
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: #fafcfc;
  font-size: 12px;
}
.claude-app button:hover {
  background: #e7eef2;
}
.cs-muted {
  color: #526976;
  font-size: 12px;
}
.cs-layout {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.cs-layout.cs-focus {
  grid-template-columns: minmax(0, 1fr);
}
.cs-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--line);
}
.cs-search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px;
  border-bottom: 1px solid var(--line);
}
.cs-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 5px;
}
.cs-session-list {
  overflow: auto;
  min-height: 0;
}
.cs-session {
  display: grid !important;
  text-align: left;
  gap: 5px !important;
  width: 100%;
  padding: 12px;
  border-bottom: 1px solid #e2e8eb;
}
.cs-session strong {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cs-session span,
.cs-session time {
  font-size: 12px;
  color: #526976;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-session.selected {
  background: #e0e9ef;
  box-shadow: inset 0 0 0 1px #b6c9d5;
}
.cs-session-view {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.cs-session-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}
.cs-session-header > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.cs-session-header > div > strong,
.cs-session-header > div > span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cs-session-header strong {
  font-weight: 500;
}
.cs-back {
  display: none !important;
}
.cs-content {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.cs-chat {
  overflow: auto;
  min-height: 0;
  padding: 18px;
  overflow-wrap: anywhere;
  scrollbar-gutter: stable;
}
.cs-message {
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
  display: grid;
  gap: 10px;
  min-width: 0;
}
.cs-message:first-of-type {
  padding-top: 0;
}
.cs-message-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: #526976;
}
.cs-message-meta strong {
  font-weight: 500;
  color: #455968;
}
.cs-user .cs-message-text {
  background: #e7eef2;
  padding: 10px 12px;
  border-radius: 3px;
}
.cs-message-text {
  line-height: 1.65;
  max-width: 100%;
}
.cs-tool-details {
  font-size: 12px;
  color: #526976;
}
.cs-tool-details > div {
  display: grid;
  gap: 4px;
  padding: 8px 0;
}
.cs-empty {
  padding: 18px;
  line-height: 1.6;
  color: #526976;
}
.cs-warning {
  font-size: 12px;
  padding-bottom: 12px;
  color: #795433;
}
.cs-error {
  margin: 0;
  padding: 8px 12px;
  background: #f2e3da;
  color: #80432c;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.cs-welcome {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 14px;
  max-width: 520px;
  padding: 32px;
  line-height: 1.6;
}
.cs-welcome p {
  margin: 0;
}
.cs-loose {
  display: grid;
  gap: 12px;
  margin-top: 20px;
}
.cs-loose h3 {
  font-size: 14px;
  font-weight: 500;
  margin: 0;
}
.cs-expanded {
  min-width: 0;
  overflow: auto;
  padding: 14px;
  background: #edf0f2;
}
.cs-expanded > header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.cs-older {
  margin-bottom: 18px;
}
@container (max-width:650px) {
  .cs-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .cs-has-selection .cs-sidebar {
    display: none;
  }
  .cs-back {
    display: inline-flex !important;
  }
  .cs-sidebar {
    border-right: 0;
  }
  .cs-welcome {
    display: none;
  }
  .cs-toolbar {
    gap: 8px;
    padding: 9px 10px;
  }
  .cs-toolbar > .cs-muted {
    display: none;
  }
  .cs-chat {
    padding: 12px;
  }
  .cs-session-header {
    padding: 9px 10px;
  }
  .cs-message-text {
    max-width: 100%;
  }
}
</style>
