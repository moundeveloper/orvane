<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { siteName, type PasswordList, type PasswordsApi } from "../passwords";
import Icon from "./Icon.vue";

const props = defineProps<{
  api: PasswordsApi;
  origin?: string;
  /** Bumped by the Browser when a login is saved, to show it right away. */
  revision?: number;
}>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();

const data = ref<PasswordList>();
const query = ref("");
const notice = ref("");
const confirming = ref("");

async function refresh() {
  data.value = await props.api.list().catch(() => undefined);
}
onMounted(refresh);
watch(() => props.revision, refresh);

// Close on a click or focus anywhere else (a click into a web page only
// shows up here as focus moving to its <webview>). The key button that
// toggles the panel handles itself.
function outside(event: Event) {
  const target = event.target;
  if (
    target instanceof Node &&
    !panel.value?.contains(target) &&
    !(target instanceof Element && target.closest("[data-passwords-toggle]"))
  )
    emit("close");
}
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("focusin", outside);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  document.removeEventListener("focusin", outside);
});

const shown = computed(() => {
  const text = query.value.trim().toLowerCase();
  const logins = data.value?.logins ?? [];
  const matching = text
    ? logins.filter(
        (l) =>
          l.origin.toLowerCase().includes(text) ||
          l.username.toLowerCase().includes(text),
      )
    : logins;
  // Logins for the open page first.
  return [...matching].sort(
    (a, b) => Number(b.origin === props.origin) - Number(a.origin === props.origin),
  );
});

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function tell(message: string) {
  notice.value = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 4000);
}
async function copy(id: string) {
  if (await props.api.copy(id).catch(() => false))
    tell("Password copied. It is cleared from the clipboard in 30 seconds.");
}
async function remove(id: string) {
  // Deleting can't be undone: ask for a second click.
  if (confirming.value !== id) {
    confirming.value = id;
    return;
  }
  confirming.value = "";
  if (await props.api.remove(id).catch(() => false)) await refresh();
}
async function setAutoLogin(id: string, on: boolean) {
  if (await props.api.setAutoLogin(id, on).catch(() => false)) {
    await refresh();
    tell(on ? "Auto sign-in turned on." : "Auto sign-in turned off.");
  }
}
async function allow(origin: string) {
  if (await props.api.allow(origin).catch(() => false)) await refresh();
}
</script>

<template>
  <section
    ref="panel"
    class="passwords"
    aria-label="Saved passwords"
    @keydown.stop
    @keydown.esc="$emit('close')"
    @wheel.stop
  >
    <header>
      <Icon name="key" :size="14" />
      <h3>Saved passwords</h3>
      <button type="button" class="icon-button" aria-label="Close passwords" @click="$emit('close')">
        <Icon name="close" :size="13" />
      </button>
    </header>
    <p v-if="!data" class="passwords-note">Opening…</p>
    <p v-else-if="data.state === 'unavailable'" class="passwords-note warn">
      This computer has no secure key store for Orvane to encrypt passwords
      with, so saving passwords is turned off.
    </p>
    <p v-else-if="data.state === 'unreadable'" class="passwords-note warn">
      The saved passwords can't be opened with this account's key (another
      user, another computer, or a damaged file). They are left untouched.
    </p>
    <template v-else>
      <input
        v-model="query"
        class="passwords-search"
        aria-label="Search saved passwords"
        placeholder="Search sites and usernames"
        spellcheck="false"
        autocomplete="off"
      />
      <ul v-if="shown.length" class="passwords-list">
        <li v-for="login in shown" :key="login.id" :class="{ current: login.origin === origin }">
          <div class="passwords-who">
            <strong :title="login.origin">{{ siteName(login.origin) }}</strong>
            <span>{{ login.username || "(no username)" }}</span>
          </div>
          <button
            v-if="login.autoLogin !== undefined"
            type="button"
            class="icon-button passwords-auto"
            :class="{ on: login.autoLogin }"
            :aria-pressed="login.autoLogin"
            :aria-label="`Auto sign-in for ${login.username || siteName(login.origin)}`"
            :title="
              login.autoLogin
                ? 'Auto sign-in on: fills and submits NetSuite sandbox login pages (and account 1964539). Click to turn off.'
                : 'Auto sign-in off. Click to turn on.'
            "
            @click="setAutoLogin(login.id, !login.autoLogin)"
          >
            <Icon name="enter" :size="13" />
          </button>
          <button
            type="button"
            class="icon-button"
            :aria-label="`Copy password for ${login.username || siteName(login.origin)}`"
            @click="copy(login.id)"
          >
            <Icon name="copy" :size="13" />
          </button>
          <button
            type="button"
            class="icon-button"
            :class="{ danger: confirming === login.id }"
            :aria-label="
              confirming === login.id
                ? 'Click again to delete'
                : `Delete password for ${login.username || siteName(login.origin)}`
            "
            :title="confirming === login.id ? 'Click again to delete' : 'Delete'"
            @click="remove(login.id)"
            @blur="confirming === login.id && (confirming = '')"
          >
            <Icon name="trash" :size="13" />
          </button>
        </li>
      </ul>
      <p v-else class="passwords-note">
        {{
          query
            ? "No saved password matches."
            : "No saved passwords yet. Sign in to a site and Orvane offers to save it."
        }}
      </p>
      <template v-if="data.never.length">
        <h4>Never saved</h4>
        <ul class="passwords-list">
          <li v-for="site in data.never" :key="site">
            <div class="passwords-who">
              <strong :title="site">{{ siteName(site) }}</strong>
            </div>
            <button
              type="button"
              class="icon-button"
              :aria-label="`Allow saving passwords for ${siteName(site)}`"
              title="Allow saving again"
              @click="allow(site)"
            >
              <Icon name="close" :size="12" />
            </button>
          </li>
        </ul>
      </template>
    </template>
    <p v-if="notice" class="passwords-note" role="status">{{ notice }}</p>
  </section>
</template>

<style scoped>
.passwords {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(340px, calc(100% - 16px));
  max-height: calc(100% - 16px);
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface, #f7f9fa);
  box-shadow: 0 10px 28px rgba(32, 52, 64, 0.16);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 7px;
}
h3 {
  flex: 1;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: #455968;
}
h4 {
  margin: 6px 0 0;
  font-size: 11px;
  font-weight: 600;
  color: #607482;
}
.passwords-search {
  padding: 6px 9px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #fff;
  color: inherit;
  font-size: 12px;
}
.passwords-list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}
.passwords-list li {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px 4px 5px 8px;
  border-radius: 5px;
}
.passwords-list li:hover,
.passwords-list li.current {
  background: #eef3f5;
}
.passwords-who {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.passwords-who > * {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.passwords-who strong {
  font-weight: 500;
  color: #455968;
}
.passwords-who span {
  font-size: 11px;
  color: #607482;
}
.passwords-auto {
  color: #8597a2;
}
.passwords-auto.on {
  color: #fff;
  background: #4f7a68;
}
.icon-button.danger {
  color: #fff;
  background: #b5554d;
}
.passwords-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #607482;
}
.passwords-note.warn {
  color: #9a4b45;
}
</style>
