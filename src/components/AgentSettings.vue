<script setup lang="ts">
// Agent Sessions → Settings: the Orvane MCP for the Claude and Codex CLIs
// (install, test, remove through each CLI's own `mcp` commands) and session
// preferences. Nothing is written until Install or Remove is pressed.
import { onMounted, reactive, ref } from "vue";
import {
  agentEditModeNames,
  agentEditModes,
  agentNames,
  type AgentEditMode,
  type AgentProvider,
} from "../agentSessions";
import { harness } from "../agentHarness";
import { agentRequest } from "../exposition";
import Icon from "./Icon.vue";
import HostSettings from "./HostSettings.vue";

type McpRow = {
  provider: AgentProvider;
  cli: boolean;
  installed: boolean;
  where: string;
  preview: string;
  server?: { command: string; args: string[] };
};

const suggest = defineModel<boolean>("suggest", { required: true });
const rows = ref<McpRow[]>([]);
const loading = ref(true);
const error = ref("");
const busy = reactive<Partial<Record<AgentProvider, string>>>({});
const tested = reactive<Partial<Record<AgentProvider, number>>>({});
const open = reactive<Partial<Record<AgentProvider, boolean>>>({});
const root = ref<HTMLElement>();
// The edit mode new chats start in; unset is what the CLI does by itself.
const modeHints: Record<AgentEditMode, string> = {
  ask: "Asks before each edit or command",
  auto: "Accepts file edits, asks for the rest",
  plan: "Plans only, changes nothing",
  full: "Runs everything without asking",
};
function defaultMode(provider: AgentProvider) {
  return harness.settings.defaultModes?.[provider] ?? agentEditModes[provider][0]!;
}
function setDefaultMode(provider: AgentProvider, mode: AgentEditMode) {
  harness.settings.defaultModes = { ...harness.settings.defaultModes, [provider]: mode };
}
function modeKey(event: KeyboardEvent, provider: AgentProvider) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const list = agentEditModes[provider];
  const at = list.indexOf(defaultMode(provider));
  const next = list[(at + (event.key === "ArrowRight" ? 1 : -1) + list.length) % list.length]!;
  setDefaultMode(provider, next);
  void Promise.resolve().then(() =>
    (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(),
  );
}

async function load() {
  loading.value = true;
  try {
    rows.value = (await agentRequest<{ rows: McpRow[] }>("mcp-status")).rows;
    for (const row of rows.value) if (open[row.provider] === undefined) open[row.provider] = row.cli && !row.installed;
    error.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not read the CLI settings.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function act(row: McpRow, op: "install" | "remove" | "test") {
  if (busy[row.provider]) return;
  busy[row.provider] = op;
  error.value = "";
  let installed: McpRow | undefined;
  try {
    if (op === "test") {
      tested[row.provider] = (await agentRequest<{ tools: number }>("mcp-test", { provider: row.provider })).tools;
    } else {
      rows.value = (await agentRequest<{ rows: McpRow[] }>(`mcp-${op}`, { provider: row.provider })).rows;
      delete tested[row.provider];
      open[row.provider] = op === "remove";
      if (op === "install") installed = rows.value.find((r) => r.provider === row.provider && r.installed);
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "That did not work.";
  } finally {
    delete busy[row.provider];
  }
  // A fresh install is checked right away: start the server, count its tools.
  if (installed) await act(installed, "test");
}
function rowKey(event: KeyboardEvent, row: McpRow) {
  if (event.key === "Escape" && open[row.provider]) {
    event.stopPropagation();
    open[row.provider] = false;
  } else if (event.key === "Enter" && open[row.provider] && row.cli && !row.installed && event.target === event.currentTarget) {
    event.preventDefault();
    void act(row, "install");
  }
}
const serverLine = (row: McpRow) => {
  const server = rows.value.find((r) => r.installed)?.server ?? row.server;
  return server ? `${server.command} ${server.args.join(" ")}` : "";
};
defineExpose({ focus: () => root.value?.focus() });
</script>

<template>
  <section ref="root" class="as-settings" tabindex="-1" aria-label="Settings">
    <h1>Settings</h1>
    <p class="as-sub">For the Claude and Codex sessions Orvane starts on this computer.</p>

    <HostSettings />

    <h2>Orvane MCP</h2>
    <p v-if="loading && !rows.length" class="as-note">Checking the CLIs…</p>
    <div v-else class="as-card" role="list" aria-label="Orvane MCP">
      <template v-for="row in rows" :key="row.provider">
        <div class="as-row" role="listitem" :aria-label="agentNames[row.provider]" tabindex="0" @keydown="rowKey($event, row)">
          <span class="as-logo"><Icon :name="row.provider === 'claude' ? 'ai' : 'code'" :size="15" /></span>
          <span class="as-name"><b>{{ agentNames[row.provider] }}</b><code :title="row.where">{{ row.where }}</code></span>
          <span v-if="!row.cli" class="as-state off"><i></i>CLI not found</span>
          <span v-else-if="busy[row.provider] === 'test'" class="as-state"><i></i>Testing…</span>
          <span v-else-if="row.installed" class="as-state ok"
            ><i></i>{{ tested[row.provider] !== undefined ? `Connected · ${tested[row.provider]} tools` : "Set up" }}</span
          >
          <span v-else class="as-state off"><i></i>Not set up</span>
          <span class="as-acts">
            <template v-if="row.cli && row.installed">
              <button type="button" class="as-btn ghost" :disabled="!!busy[row.provider]" @click="act(row, 'test')">Test</button>
              <button type="button" class="as-btn ghost" :disabled="!!busy[row.provider]" @click="act(row, 'remove')">
                {{ busy[row.provider] === "remove" ? "Removing…" : "Remove" }}
              </button>
            </template>
            <template v-else-if="row.cli">
              <button type="button" class="as-btn primary" :disabled="!!busy[row.provider]" @click="act(row, 'install')">
                {{ busy[row.provider] === "install" ? "Installing…" : "Install" }}
              </button>
              <button type="button" class="as-caret" :aria-expanded="!!open[row.provider]"
                :aria-label="open[row.provider] ? 'Hide what gets written' : 'Show what gets written'"
                @click="open[row.provider] = !open[row.provider]">
                <Icon name="down" :size="12" />
              </button>
            </template>
          </span>
        </div>
        <div v-if="row.cli && !row.installed && open[row.provider]" class="as-more">
          <p>
            Install adds this entry with
            <code>{{ row.provider === "claude" ? "claude mcp add -s user" : "codex mcp add" }}</code>.
            {{ agentNames[row.provider] }} sessions already open load it after a restart.
          </p>
          <pre>{{ row.preview }}</pre>
          <div class="as-foot"><kbd>Enter</kbd><span>install</span><kbd>Esc</kbd><span>close</span></div>
        </div>
      </template>
    </div>
    <p v-if="error" class="as-error" role="alert">{{ error }}</p>
    <p v-if="rows.length" class="as-note">
      Same server for both: <code>{{ serverLine(rows[0]!) }}</code>. Nothing is written until you press Install.
    </p>

    <h2>Sessions</h2>
    <div class="as-card">
      <div v-for="name in (['claude', 'codex'] as AgentProvider[])" :key="name" class="as-toggle">
        <span
          ><b>Default mode for new {{ agentNames[name] }} chats</b
          ><small>{{ modeHints[defaultMode(name)] }}. You can still change it per chat (Shift+Tab).</small></span
        >
        <span
          class="as-seg"
          role="radiogroup"
          :aria-label="`Default mode for ${agentNames[name]}`"
          @keydown="modeKey($event, name)"
        >
          <button
            v-for="mode in agentEditModes[name]"
            :key="mode"
            type="button"
            role="radio"
            :aria-checked="defaultMode(name) === mode"
            :tabindex="defaultMode(name) === mode ? 0 : -1"
            @click="setDefaultMode(name, mode)"
          >
            {{ agentEditModeNames[mode] }}
          </button>
        </span>
      </div>
      <div class="as-toggle">
        <span><b>Suggest next message</b><small>Offer a follow-up in the composer when a run finishes.</small></span>
        <button type="button" class="as-switch" role="switch" :aria-checked="suggest" aria-label="Suggest next message"
          @click="suggest = !suggest"></button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.as-settings {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 22px 34px;
  outline: none;
  color: #455968;
  font-size: 13px;
}
h1 {
  margin: 0 0 2px;
  color: #273f50;
  font-size: 15px;
  font-weight: 600;
}
.as-sub {
  margin: 0 0 20px;
  color: #8296a2;
  font-size: 12px;
}
h2 {
  margin: 0 0 8px;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.as-card {
  max-width: 760px;
  overflow: hidden;
  border: 1px solid #dbe5ea;
  border-radius: 10px;
  background: #f2f6f8;
}
.as-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 10px 14px;
  outline: none;
}
.as-row:focus-visible {
  box-shadow: inset 0 0 0 2px #6f899840;
}
.as-row + .as-row,
.as-row + .as-more,
.as-more + .as-row {
  border-top: 1px solid #e3eaee;
}
.as-logo {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: #e3ecf1;
  color: #273f50;
}
.as-name {
  display: grid;
  gap: 1px;
  min-width: 0;
}
.as-name b {
  color: #273f50;
  font-weight: 550;
}
.as-name code {
  overflow: hidden;
  color: #8296a2;
  font: 11.5px "Cascadia Code", Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.as-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: #e6eef3;
  color: #5d7381;
  font-size: 11.5px;
  white-space: nowrap;
}
.as-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #6f8998;
}
.as-state.ok {
  background: #e6f0e9;
  color: #3f6b4f;
}
.as-state.ok i {
  background: #4f7d5f;
}
.as-state.off {
  background: #f6f0e4;
  color: #8a6a33;
}
.as-state.off i {
  background: #b08a4a;
}
.as-acts {
  display: flex;
  align-items: center;
  gap: 6px;
}
.as-btn {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 10px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  color: #455968;
  font: inherit;
  font-size: 12px;
}
.as-btn:hover:not(:disabled) {
  background: #eef3f6;
}
.as-btn.ghost {
  border-color: transparent;
  background: none;
  color: #5d7381;
}
.as-btn.ghost:hover:not(:disabled) {
  background: #eef3f6;
  color: #273f50;
}
.as-btn.primary {
  border-color: #365f78;
  background: #365f78;
  color: #fff;
}
.as-btn.primary:hover:not(:disabled) {
  background: #2f5469;
}
.as-btn:disabled {
  opacity: 0.6;
}
.as-btn:focus-visible,
.as-caret:focus-visible,
.as-switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px #6f899840;
}
.as-caret {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #8296a2;
}
.as-caret:hover {
  background: #eef3f6;
}
.as-caret[aria-expanded="true"] :deep(svg) {
  transform: rotate(180deg);
}
.as-more {
  padding: 2px 14px 14px 54px;
}
.as-more p {
  margin: 0 0 8px;
  color: #5d7381;
  font-size: 12px;
}
.as-more p code,
.as-note code {
  color: #385d76;
  font: 11.5px "Cascadia Code", Consolas, monospace;
}
.as-more pre {
  margin: 0;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid #dbe5eb;
  border-radius: 8px;
  background: #fbfcfd;
  color: #273f50;
  font: 11.5px/1.6 "Cascadia Code", Consolas, monospace;
}
.as-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: #8296a2;
  font-size: 11.5px;
}
.as-foot kbd + span {
  margin-right: 8px;
}
kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  color: #5d7381;
  font: 10.5px/1 "Cascadia Code", Consolas, monospace;
}
.as-note {
  max-width: 760px;
  margin: 10px 2px 26px;
  color: #8296a2;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.as-error {
  max-width: 760px;
  margin: 10px 2px 0;
  color: #a0624f;
  font-size: 12px;
}
.as-toggle {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 8px 14px;
}
.as-toggle + .as-toggle {
  border-top: 1px solid #e3eaee;
}
/* Segmented control (design guide: track #e8eff3, pressed button raised). */
.as-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}
.as-seg button {
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: #5d7381;
  font: inherit;
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
}
.as-seg button:hover {
  color: #273f50;
}
.as-seg button[aria-checked="true"] {
  background: #fbfcfd;
  color: #273f50;
  box-shadow: 0 1px 2px #263f5512;
}
.as-seg button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px #6f899866;
}
.as-toggle b {
  display: block;
  color: #273f50;
  font-weight: 550;
}
.as-toggle small {
  color: #8296a2;
  font-size: 12px;
}
.as-switch {
  position: relative;
  width: 30px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: #c9d6de;
  transition: background 0.15s;
}
.as-switch::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px #263f5533;
  content: "";
  transition: transform 0.15s;
}
.as-switch[aria-checked="true"] {
  background: #365f78;
}
.as-switch[aria-checked="true"]::after {
  transform: translateX(12px);
}
@media (prefers-reduced-motion: reduce) {
  .as-switch,
  .as-switch::after {
    transition: none;
  }
}
</style>
