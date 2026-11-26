<script setup lang="ts">
// Agent sessions → Settings → Claude accounts (approved mock "Settings
// accounts"). Each account is its own Claude Code folder. Adding one is
// inline: a new empty folder, `claude auth login` in a Terminal bound to it,
// then `claude auth status`. Orvane keeps only the name, folder and colour;
// the CLI owns the sign-in. Remove only hides the account: its folder,
// sign-in and history stay, and nothing is signed out.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import {
  accountAction,
  accountDetail,
  claudeAccounts,
  CLAUDE_LOGIN_EVENT,
  loadAccounts,
  shortFolder,
  type ClaudeAccount,
  type ClaudeLoginDetail,
} from "../claudeAccounts";

const error = ref("");
const busy = ref<Record<string, string>>({});
const confirming = ref("");
/** The inline add panel: before creation (draft) or setting up `id`. */
const adding = ref<{ name: string; folder: string; id: string; created: boolean } | null>(null);
const nameInput = ref<HTMLInputElement>();
const editing = ref<{ id: string; name: string } | null>(null);
const renameInput = ref<HTMLInputElement>();
const choiceGroup = ref<HTMLElement>();
function setRenameInput(element: unknown) {
  renameInput.value = element instanceof HTMLInputElement ? element : undefined;
}
const shown = computed(() => claudeAccounts.list.filter((a) => !a.removed));
const setup = computed(() => (adding.value?.created ? claudeAccounts.list.find((a) => a.id === adding.value!.id) : undefined));

async function act(id: string, label: string, run: () => Promise<unknown>) {
  if (busy.value[id]) return;
  busy.value = { ...busy.value, [id]: label };
  error.value = "";
  try {
    await run();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "That did not work.";
  } finally {
    const next = { ...busy.value };
    delete next[id];
    busy.value = next;
  }
}
const check = (account: ClaudeAccount) => act(account.id, "check", () => accountAction("claude-profile-check", { id: account.id }));
const useForNewChats = (account: ClaudeAccount) =>
  account.newChats ? Promise.resolve() : act(account.id, "default", () => accountAction("claude-profile-new-chats", { id: account.id }));
async function choiceKey(event: KeyboardEvent, account: ClaudeAccount) {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  const choices = shown.value.filter((item) => !busy.value[item.id]);
  const index = choices.findIndex((item) => item.id === account.id);
  const offset = ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1;
  const next = choices[event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 :
    (index + offset + choices.length) % choices.length];
  if (!next) return;
  await useForNewChats(next);
  await nextTick();
  choiceGroup.value?.querySelector<HTMLElement>(`[data-profile-choice="${next.id}"]`)?.focus({ preventScroll: true });
}
const rename = (account: ClaudeAccount, name: string) =>
  act(account.id, "rename", () => accountAction("claude-profile-rename", { id: account.id, name }));
function startRename(account: ClaudeAccount) {
  if (editing.value && busy.value[editing.value.id]) return;
  error.value = "";
  editing.value = { id: account.id, name: account.name };
  void nextTick(() => { renameInput.value?.focus(); renameInput.value?.select(); });
}
function cancelRename() {
  const id = editing.value?.id;
  editing.value = null;
  error.value = "";
  if (id) void nextTick(() => choiceGroup.value?.querySelector<HTMLElement>(`[data-profile-row="${id}"] .ca-rename-trigger`)?.focus());
}
async function saveRename(account: ClaudeAccount) {
  if (!editing.value?.name.trim() || busy.value[account.id]) return;
  await rename(account, editing.value.name);
  if (!error.value && editing.value?.id === account.id) cancelRename();
}
async function signIn(account: ClaudeAccount) {
  await act(account.id, "login", async () => {
    const { ticket, name } = await accountAction<{ ticket: string; name: string }>("claude-profile-login", { id: account.id });
    window.dispatchEvent(new CustomEvent<ClaudeLoginDetail>(CLAUDE_LOGIN_EVENT, { detail: { ticket, name } }));
    await loadAccounts();
  });
}
async function showTerminal(account: ClaudeAccount) {
  await act(account.id, "show", async () => {
    const { ticket } = await accountAction<{ ticket: string }>("claude-profile-login-show", { id: account.id });
    window.dispatchEvent(new CustomEvent<ClaudeLoginDetail>(CLAUDE_LOGIN_EVENT, { detail: { ticket, name: account.name, show: true } }));
  });
}
const cancelSignIn = (account: ClaudeAccount) =>
  act(account.id, "cancel", () => accountAction("claude-profile-login-cancel", { id: account.id }));
function askRemove(account: ClaudeAccount) {
  confirming.value = account.id;
  void nextTick(() => document.querySelector<HTMLElement>(".ca-confirm .ca-btn.danger")?.focus());
}
async function remove(account: ClaudeAccount) {
  await act(account.id, "remove", () => accountAction("claude-profile-remove", { id: account.id }));
  if (!error.value) confirming.value = "";
}
function startAdd() {
  if (!claudeAccounts.draft) return;
  confirming.value = "";
  const draft = claudeAccounts.draft;
  adding.value = { name: "", folder: draft?.folder ?? "", id: draft?.id ?? "", created: false };
  void nextTick(() => nameInput.value?.focus());
}
async function create() {
  const draft = adding.value;
  if (!draft || draft.created || !draft.name.trim()) return;
  await act("new", "add", async () => {
    const data = await accountAction<{ added: string }>("claude-profile-add", {
      id: draft.id,
      name: draft.name.trim(),
      ...(draft.folder.trim() && draft.folder.trim() !== claudeAccounts.draft?.folder ? { folder: draft.folder.trim() } : {}),
    });
    adding.value = { ...draft, id: data.added, created: true };
  });
  // The server suggested this ID before; ask for a new one if it is taken.
  if (error.value && !adding.value?.created) void loadAccounts().then(() => {
    if (adding.value && !adding.value.created && claudeAccounts.draft)
      adding.value = { ...adding.value, id: claudeAccounts.draft.id, folder: claudeAccounts.draft.folder };
  });
}
function collapse() {
  adding.value = null;
}
const editable = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
function panelKey(event: KeyboardEvent) {
  if (editable(event.target)) {
    // Enter in the name field creates; other keys belong to the field.
    if (event.key === "Enter" && !adding.value?.created) {
      event.preventDefault();
      void create();
    }
    return;
  }
  if (event.key === "Escape") {
    event.stopPropagation();
    collapse();
  } else if (event.key === "Enter" && event.target === event.currentTarget && setup.value) {
    event.preventDefault();
    void check(setup.value);
  }
}
function confirmKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    confirming.value = "";
  }
}
const signedIn = (account: ClaudeAccount) => !!account.auth?.loggedIn && account.auth.supported;
const stateOf = (account: ClaudeAccount) =>
  account.signingIn ? "wait" : !account.auth ? "" : signedIn(account) ? "ok" : "off";
const stateText = (account: ClaudeAccount) =>
  account.signingIn
    ? "Waiting for sign-in"
    : !account.auth
      ? "Checking…"
      : signedIn(account)
        ? "Signed in"
        : account.auth.loggedIn
          ? "Unsupported sign-in"
          : "Not signed in";
const fiveHour = (account: ClaudeAccount) => account.usage?.fiveHour?.used;
// While a sign-in Terminal is open, follow it until the CLI finishes.
let poll: ReturnType<typeof setInterval> | undefined;
watch(
  () => claudeAccounts.list.some((a) => a.signingIn),
  (waiting) => {
    clearInterval(poll);
    poll = waiting ? setInterval(() => void loadAccounts(), 1500) : undefined;
  },
  { immediate: true },
);
onMounted(() => void loadAccounts(true));
onBeforeUnmount(() => clearInterval(poll));
</script>

<template>
  <div class="ca-sec">
    <h2>Claude accounts</h2>
    <small>Each one is its own Claude Code folder</small>
    <button type="button" class="ca-btn" :disabled="!!adding || !claudeAccounts.draft" @click="startAdd"><Icon name="plus" :size="13" />Add account</button>
  </div>
  <p v-if="!claudeAccounts.loaded" class="ca-note">Reading the accounts…</p>
  <div v-else ref="choiceGroup" class="ca-choices" role="radiogroup" aria-label="Default for new chats">
  <div class="ca-choice-heading"><span>Default for new chats</span><small>Choose one account</small></div>
  <div class="ca-card" role="list" aria-label="Claude accounts">
    <template v-for="account in shown" :key="account.id">
      <div class="ca-row" :class="{ 'ca-selected': account.newChats }" :data-profile-row="account.id" role="listitem" :aria-label="account.name">
        <button type="button" class="ca-choice" role="radio" :data-profile-choice="account.id"
          :aria-label="`Use ${account.name} for new chats`" :aria-checked="account.newChats"
          :tabindex="account.newChats ? 0 : -1" :disabled="!!busy[account.id]"
          @click="useForNewChats(account)" @keydown="choiceKey($event, account)" />
        <span class="ca-logo"><i :style="{ background: account.color }" /></span>
        <div class="ca-main">
          <div class="ca-name">
            <form v-if="editing?.id === account.id" class="ca-rename" @submit.prevent="saveRename(account)">
              <input :ref="setRenameInput" v-model="editing.name" aria-label="Account name" maxlength="40"
                :disabled="!!busy[account.id]" @keydown.esc.stop.prevent="cancelRename" />
              <button type="submit" class="ca-btn ghost" :disabled="!editing.name.trim() || !!busy[account.id]">Save</button>
              <button type="button" class="ca-btn ghost" :disabled="!!busy[account.id]" @click="cancelRename">Cancel</button>
            </form>
            <template v-else><b>{{ account.name }}</b><button type="button" class="ca-rename-trigger"
              aria-label="Rename" :disabled="!!busy[account.id]" @click="startRename(account)"><Icon name="edit" :size="12" /></button></template>
            <span class="ca-new-chats" :class="{ active: account.newChats }">New chats</span>
            <small>{{ accountDetail(account) }}</small>
          </div>
          <div class="ca-line" :title="account.folder">
            {{ shortFolder(account.folder) }}<template v-if="account.inherited"><span>·</span>inherits Orvane's setup</template
            ><span>·</span>{{ account.mcp ? "MCP connected" : "MCP not set up" }}<span>·</span
            >{{ account.running ? `${account.running} running` : `${account.sessions} session${account.sessions === 1 ? "" : "s"}` }}
          </div>
        </div>
        <span v-if="fiveHour(account) !== undefined" class="ca-use" :class="{ warn: fiveHour(account)! >= 75 }">
          <span>5-hour <em>{{ fiveHour(account) }}%</em></span><span class="ca-meter"><i :style="{ width: `${fiveHour(account)}%` }" /></span>
        </span>
        <span v-else />
        <span class="ca-acts">
          <span class="ca-state" :class="stateOf(account)" :title="account.auth?.error"><i />{{ stateText(account) }}</span>
          <template v-if="account.signingIn">
            <button type="button" class="ca-btn ghost" @click="showTerminal(account)">Show Terminal</button>
            <button type="button" class="ca-btn ghost" @click="cancelSignIn(account)">Cancel</button>
          </template>
          <template v-else>
            <button v-if="account.auth && !signedIn(account)" type="button" class="ca-btn ghost" :disabled="!!busy[account.id] || account.running > 0"
              @click="signIn(account)">Sign in</button>
            <button type="button" class="ca-btn ghost" :disabled="!!busy[account.id]" title="Run claude auth status again" @click="check(account)">
              {{ busy[account.id] === "check" ? "Checking…" : "Check" }}
            </button>
            <button v-if="!account.isDefault" type="button" class="ca-btn ghost danger" :disabled="!!busy[account.id]" @click="askRemove(account)">Remove</button>
          </template>
        </span>
      </div>
      <div v-if="confirming === account.id" class="ca-confirm" @keydown="confirmKey">
        <p>
          <b>Remove {{ account.name }} from Orvane?</b>
          {{ account.running ? `Its ${account.running} running chat${account.running === 1 ? "" : "s"} must finish first.` : "" }}
          Old chats stay readable. The folder <code>{{ shortFolder(account.folder) }}</code> and its sign-in are kept; Orvane never
          signs out or deletes it.
        </p>
        <button type="button" class="ca-btn danger" :disabled="!!busy[account.id]" @click="remove(account)">Remove</button>
        <button type="button" class="ca-btn ghost" @click="confirming = ''">Cancel <kbd>Esc</kbd></button>
      </div>
      <div v-if="setup?.id === account.id" class="ca-more" tabindex="-1" @keydown="panelKey">
        <div class="ca-form">
          <label class="ca-field"><span>Name</span><input :value="account.name" maxlength="40"
            @change="rename(account, ($event.target as HTMLInputElement).value)" /></label>
          <label class="ca-field"><span>Folder</span><input :value="account.folder" class="mono" readonly spellcheck="false" /></label>
        </div>
        <ol class="ca-steps">
          <li>
            <svg class="ca-tick" width="14" height="14" viewBox="0 0 24 24"><path d="m5 12 4 4 10-10" /></svg>
            <span><b>Folder ready</b> <small>{{ account.generated ? "new empty folder created by Orvane" : "existing folder, used as it is" }}</small></span><span />
          </li>
          <li>
            <svg v-if="signedIn(account)" class="ca-tick draw" width="14" height="14" viewBox="0 0 24 24"><path d="m5 12 4 4 10-10" /></svg>
            <span v-else-if="account.signingIn" class="ca-spin" /><span v-else class="ca-hollow" />
            <span><b>Sign in in Terminal</b> <small><code>claude auth login</code> runs with this folder only</small></span>
            <button v-if="account.signingIn" type="button" class="ca-btn" @click="showTerminal(account)">Show Terminal</button>
            <button v-else-if="!signedIn(account)" type="button" class="ca-btn" :class="{ primary: !account.signingIn }" @click="signIn(account)">
              Open Terminal
            </button>
            <span v-else />
          </li>
          <li>
            <svg v-if="signedIn(account)" class="ca-tick draw" width="14" height="14" viewBox="0 0 24 24"><path d="m5 12 4 4 10-10" /></svg>
            <span v-else class="ca-hollow" />
            <span v-if="signedIn(account)"><b>Signed in</b> <small>{{ accountDetail(account) }}</small></span>
            <span v-else><b>Check the sign-in</b> <small>Orvane runs <code>claude auth status</code>, reads nothing else</small></span>
            <button v-if="!signedIn(account)" type="button" class="ca-btn" :disabled="!!busy[account.id]" @click="check(account)">Check now</button>
            <button v-else type="button" class="ca-btn ghost" @click="collapse">Done</button>
          </li>
        </ol>
        <p class="ca-text">The browser sign-in and the stored token belong to Claude Code in this folder. Orvane keeps only the name, the folder and the colour.</p>
        <div class="ca-keys"><kbd>Enter</kbd>check now<span /><kbd>Esc</kbd>collapse</div>
      </div>
    </template>
    <div v-if="adding && !adding.created" class="ca-row ca-new">
      <span class="ca-logo"><i style="background: #b4c3cc" /></span>
      <div class="ca-main">
        <div class="ca-name"><b>New account</b><small>Not created yet</small></div>
        <div class="ca-line">{{ shortFolder(adding.folder) }}<span>·</span>new</div>
      </div>
      <span />
      <span class="ca-acts"><button type="button" class="ca-btn ghost" aria-label="Collapse" @click="collapse"><Icon name="up" :size="13" /></button></span>
    </div>
    <div v-if="adding && !adding.created" class="ca-more" @keydown="panelKey">
      <div class="ca-form">
        <label class="ca-field"><span>Name</span><input ref="nameInput" v-model="adding.name" maxlength="40" placeholder="Work" /></label>
        <label class="ca-field"><span>Folder</span><input v-model="adding.folder" class="mono" spellcheck="false" /></label>
      </div>
      <p class="ca-text">
        Orvane creates this folder empty; nothing is copied from your other accounts. An existing Claude Code folder can be used as it is.
      </p>
      <div class="ca-keys">
        <button type="button" class="ca-btn primary" :disabled="!adding.name.trim() || !!busy.new" @click="create">
          {{ busy.new ? "Creating…" : "Create account" }}
        </button>
        <kbd>Enter</kbd>create<span /><kbd>Esc</kbd>collapse
      </div>
    </div>
  </div>
  </div>
  <p v-if="error || claudeAccounts.error" class="ca-error" role="alert">{{ error || claudeAccounts.error }}</p>
  <p class="ca-foot">New Claude chats use <b>{{ claudeAccounts.list.find((account) => account.newChats)?.name ?? "Default" }}</b>. Existing chats keep their account.</p>
</template>

<style scoped>
.ca-sec {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 760px;
  margin: 0 0 8px;
}
.ca-sec h2 {
  margin: 0;
  color: #7a8f9b;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.ca-sec small {
  color: #8296a2;
  font-size: 11.5px;
}
.ca-sec .ca-btn {
  margin-left: auto;
}
.ca-card {
  max-width: 760px;
  overflow: hidden;
  border: 1px solid #dbe5ea;
  border-radius: 10px;
  background: #f2f6f8;
}
.ca-row {
  display: grid;
  grid-template-columns: 20px 30px minmax(0, 1fr) 110px auto;
  align-items: center;
  gap: 10px;
  min-height: 62px;
  padding: 16px;
}
.ca-new { grid-template-columns: 30px minmax(0, 1fr) 110px auto; }
.ca-selected { background: #edf4f7; }
.ca-choices { max-width: 760px; }
.ca-choice-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 20px 0 12px; color: #273f50; font-weight: 550; }
.ca-choice-heading small { color: #8296a2; font-size: 12px; font-weight: 400; }
.ca-choice { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 1.5px solid #a6b9c5; border-radius: 50%; background: #fbfcfd; cursor: pointer; }
.ca-choice[aria-checked="true"] { border-color: #6f8998; }
.ca-choice[aria-checked="true"]::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: #6f8998; }
.ca-choice:focus-visible, .ca-rename-trigger:focus-visible { outline: 2px solid #7b97a7; outline-offset: 2px; }
.ca-choice:disabled { cursor: wait; opacity: 0.6; }
.ca-new-chats { visibility: hidden; color: #385d76; font-size: 11px; white-space: nowrap; }
.ca-new-chats.active { visibility: visible; }
.ca-rename-trigger { display: inline-flex; align-items: center; padding: 1px 3px; border: 0; background: none; color: #8296a2; cursor: pointer; }
.ca-rename-trigger:hover { color: #385d76; }
.ca-row + .ca-row,
.ca-row + .ca-more,
.ca-more + .ca-row,
.ca-confirm + .ca-row,
.ca-more + .ca-more {
  border-top: 1px solid #dde6eb;
}
.ca-logo {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: #e3ecf1;
}
.ca-logo i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.ca-main {
  min-width: 0;
}
.ca-name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  min-width: 0;
}
.ca-name b {
  color: #273f50;
  font-weight: 600;
}
.ca-name small {
  flex-basis: 100%;
  overflow: hidden;
  color: #8296a2;
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ca-line {
  margin-top: 3px;
  overflow: hidden;
  color: #8296a2;
  font: 11.5px "Cascadia Code", Consolas, monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ca-line span {
  margin: 0 5px;
  color: #b4c3cc;
}
.ca-use {
  display: grid;
  gap: 2px;
  width: 110px;
}
.ca-use > span:first-child {
  display: flex;
  justify-content: space-between;
  color: #8296a2;
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}
.ca-use em {
  color: #5d7381;
  font-style: normal;
}
.ca-meter {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: #e3eaee;
}
.ca-meter i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: #6f8998;
}
.ca-use.warn em {
  color: #8a6a33;
}
.ca-use.warn .ca-meter i {
  background: #b08a4a;
}
.ca-acts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.ca-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  margin-right: 4px;
  padding: 0 9px;
  border-radius: 7px;
  background: #eef3f6;
  color: #5d7381;
  font-size: 12px;
  white-space: nowrap;
}
.ca-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.ca-state.ok {
  background: #e4efe7;
  color: #4f7d5f;
}
.ca-state.wait,
.ca-state.off {
  background: #f5efe3;
  color: #8a6a33;
}
.ca-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid #d3dee5;
  border-radius: 7px;
  background: #fbfcfd;
  color: #455968;
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.ca-btn:hover:not(:disabled) {
  background: #eef3f6;
}
.ca-btn.ghost {
  border-color: transparent;
  background: none;
  color: #5d7381;
}
.ca-btn.ghost:hover:not(:disabled) {
  background: #eef3f6;
}
.ca-btn.primary {
  border-color: #365f78;
  background: #365f78;
  color: #fff;
}
.ca-btn.primary:hover:not(:disabled) {
  background: #2f5469;
}
.ca-btn.danger {
  color: #a0624f;
}
.ca-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.ca-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px #6f899840;
}
.ca-more {
  padding: 12px 14px 14px 56px;
  outline: none;
  background: #f5f8fa;
  animation: ca-in 180ms ease-out;
}
@keyframes ca-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
.ca-form {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 10px;
  margin-bottom: 10px;
}
.ca-field {
  display: grid;
  gap: 4px;
}
.ca-field span {
  color: #5d7381;
  font-size: 11.5px;
}
.ca-field input,
.ca-rename input {
  height: 32px;
  padding: 0 10px;
  border: 1px solid #dbe5eb;
  border-radius: 7px;
  outline: none;
  background: #fbfcfd;
  box-shadow: inset 0 -1px 0 #e3eaee;
  color: #273f50;
  font: inherit;
}
.ca-field input.mono {
  font: 12px "Cascadia Code", Consolas, monospace;
}
.ca-field input:focus,
.ca-rename input:focus {
  border-color: #7b97a7;
  background: #fdfefe;
}
.ca-name:has(.ca-rename) { flex-wrap: wrap; }
.ca-rename { display: flex; flex-wrap: wrap; flex: 1 0 100%; align-items: center; gap: 4px; min-width: 0; }
.ca-rename input { width: 130px; min-width: 70px; height: 26px; padding: 0 7px; }
.ca-steps {
  display: grid;
  gap: 2px;
  margin: 0 0 10px;
  padding: 0;
  list-style: none;
}
.ca-steps li {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 10px;
  min-height: 30px;
}
.ca-steps b {
  color: #273f50;
  font-weight: 500;
}
.ca-steps small {
  color: #8296a2;
  font-size: 12px;
}
.ca-steps code,
.ca-confirm code {
  color: #273f50;
  font: 11.5px "Cascadia Code", Consolas, monospace;
}
.ca-tick {
  fill: none;
  stroke: #4f7d5f;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.ca-tick path {
  stroke-dasharray: 20;
}
.ca-tick.draw path {
  stroke-dashoffset: 20;
  animation: ca-draw 260ms 100ms ease-out forwards;
}
@keyframes ca-draw {
  to {
    stroke-dashoffset: 0;
  }
}
.ca-spin {
  justify-self: center;
  width: 12px;
  height: 12px;
  border: 1.6px solid #bfd0da;
  border-top-color: #365f78;
  border-radius: 50%;
  animation: ca-spin 0.9s linear infinite;
}
@keyframes ca-spin {
  to {
    transform: rotate(360deg);
  }
}
.ca-hollow {
  justify-self: center;
  width: 9px;
  height: 9px;
  border: 1.5px solid #b4c3cc;
  border-radius: 50%;
}
.ca-text {
  max-width: 64ch;
  margin: 0 0 10px;
  color: #5d7381;
  font-size: 12px;
}
.ca-keys {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #8296a2;
  font-size: 11.5px;
}
.ca-keys > span {
  width: 10px;
}
.ca-keys .ca-btn {
  margin-right: 8px;
}
.ca-confirm {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px 10px 56px;
  border-top: 1px solid #f0dcd4;
  background: #fbf4f1;
  font-size: 12.5px;
  animation: ca-in 160ms ease-out;
}
.ca-confirm p {
  max-width: 62ch;
  margin: 0 auto 0 0;
}
.ca-confirm b {
  color: #273f50;
  font-weight: 600;
}
.ca-note,
.ca-foot {
  max-width: 760px;
  margin: 10px 2px 22px;
  color: #8296a2;
  font-size: 12px;
}
.ca-error {
  max-width: 760px;
  margin: 10px 2px 0;
  color: #a0624f;
  font-size: 12px;
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
@media (prefers-reduced-motion: reduce) {
  .ca-more,
  .ca-confirm,
  .ca-spin,
  .ca-tick.draw path {
    animation: none;
  }
  .ca-tick.draw path {
    stroke-dashoffset: 0;
  }
}
</style>
