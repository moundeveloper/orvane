<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch,
} from "vue";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
import {
  certificateRequest,
  type CertificateEnvironment,
} from "../certificates";
import {
  apiKeyRecordSchema,
  deriveVaultKey,
  generateApiSecret,
  openVault,
  sealVault,
  toBase64,
  type ApiKeyRecord,
  type VaultState,
} from "../apiKeyVault";

const props = defineProps<{
  environments: CertificateEnvironment[];
  environmentId: string;
  active: boolean;
  kind: "api-key" | "api-secret";
}>();
const isApiSecret = computed(() => props.kind === "api-secret");
const singular = computed(() => (isApiSecret.value ? "API secret" : "API key"));
const plural = computed(() => (isApiSecret.value ? "API secrets" : "API keys"));
const state = ref<VaultState>({ revision: 0, envelope: null });
const key = shallowRef<CryptoKey>();
const records = ref<ApiKeyRecord[]>([]),
  salt = ref("");
const loading = ref(true),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const password = ref(""),
  confirmation = ref(""),
  search = ref(""),
  selected = ref(""),
  revealed = ref(false);
const editing = ref(false),
  changingPassword = ref(false),
  removing = ref(false),
  draftVisible = ref(false);
const dialog = ref<HTMLDialogElement>(),
  dialogError = ref("");
const dialogTitleId = `api-key-dialog-${crypto.randomUUID()}`;
const draft = reactive({
  id: "",
  kind: "api-key" as "api-key" | "api-secret",
  name: "",
  purpose: "",
  environmentId: "",
  secret: "",
});
let epoch = 0,
  lastActivity = Date.now();
let idleTimer: ReturnType<typeof setInterval> | undefined;
const options = computed(() =>
  props.environments.map((e) => ({
    value: e.id,
    label: `${e.name} · ${e.accountId}`,
  })),
);
const filtered = computed(() =>
  records.value.filter((record) => {
    const env = props.environments.find((e) => e.id === record.environmentId);
    return (
      (record.kind || "api-key") === props.kind &&
      (!props.environmentId || record.environmentId === props.environmentId) &&
      [record.name, record.purpose, env?.name, env?.accountId]
        .join(" ")
        .toLowerCase()
        .includes(search.value.trim().toLowerCase())
    );
  }),
);
const groups = computed(() =>
  [...new Set(filtered.value.map((r) => r.environmentId))]
    .map((id) => ({
      id,
      environment: props.environments.find((e) => e.id === id),
      records: filtered.value
        .filter((r) => r.environmentId === id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) =>
      (a.environment?.name || "").localeCompare(b.environment?.name || ""),
    ),
);
const current = computed(
  () =>
    filtered.value.find((r) => r.id === selected.value) || filtered.value[0],
);
watch(
  () => current.value?.id,
  () => {
    revealed.value = false;
  },
);
watch(
  () => props.active,
  (active) => {
    if (!active) lock();
  },
);
watch(
  () => props.kind,
  () => {
    closeDialog();
    search.value = "";
    selected.value = "";
    revealed.value = false;
    error.value = "";
    notice.value = "";
  },
);
function activity() {
  lastActivity = Date.now();
}
function clearDraft() {
  Object.assign(draft, {
    id: "",
    kind: props.kind,
    name: "",
    purpose: "",
    environmentId: "",
    secret: "",
  });
  draftVisible.value = false;
}
function closeDialog() {
  dialog.value?.close();
  clearDraft();
  password.value = "";
  confirmation.value = "";
  editing.value = false;
  changingPassword.value = false;
  removing.value = false;
  dialogError.value = "";
}
function lock(reason = "") {
  epoch++;
  key.value = undefined;
  records.value = [];
  salt.value = "";
  revealed.value = false;
  password.value = "";
  confirmation.value = "";
  search.value = "";
  selected.value = "";
  closeDialog();
  notice.value = reason;
}
async function readState() {
  const value = await certificateRequest<VaultState>("vault-read");
  state.value = value;
  return value;
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    await readState();
  } catch {
    error.value = "Could not load the API key vault. Try again.";
  } finally {
    loading.value = false;
  }
}
async function authenticate() {
  if (busy.value || loading.value) return;
  error.value = "";
  notice.value = "";
  const inputPassword = password.value,
    inputConfirmation = confirmation.value;
  password.value = "";
  confirmation.value = "";
  if (
    !state.value.envelope &&
    (inputPassword.length < 12 || inputPassword !== inputConfirmation)
  ) {
    error.value =
      "Use at least 12 characters and enter the same password twice.";
    return;
  }
  busy.value = true;
  const operation = epoch;
  try {
    const latest = await readState();
    if (operation !== epoch || !props.active) return;
    if (latest.envelope) {
      const unlocked = await openVault(inputPassword, latest.envelope);
      if (operation !== epoch || !props.active) return;
      key.value = unlocked.key;
      records.value = unlocked.records;
      salt.value = unlocked.salt;
    } else {
      if (inputPassword.length < 12 || inputPassword !== inputConfirmation)
        throw Error(
          "Use at least 12 characters and enter the same password twice.",
        );
      const nextSalt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
      const nextKey = await deriveVaultKey(inputPassword, nextSalt);
      if (operation !== epoch || !props.active) return;
      const envelope = await sealVault(nextKey, nextSalt, []);
      const saved = await certificateRequest<VaultState>("vault-write", {
        expectedRevision: latest.revision,
        envelope,
      });
      state.value = saved;
      if (operation !== epoch || !props.active) return;
      key.value = nextKey;
      salt.value = nextSalt;
      records.value = [];
    }
    activity();
  } catch (e) {
    if (operation === epoch)
      error.value =
        e instanceof Error ? e.message : "Could not unlock the API key vault.";
  } finally {
    busy.value = false;
  }
}
async function openEditor(record?: ApiKeyRecord) {
  if (!key.value || busy.value) return;
  clearDraft();
  Object.assign(
    draft,
    record || {
      environmentId: props.environmentId || props.environments[0]?.id || "",
    },
  );
  editing.value = true;
  changingPassword.value = false;
  removing.value = false;
  dialogError.value = "";
  await nextTick();
  dialog.value?.showModal();
}
async function openPasswordChange() {
  if (!key.value || busy.value) return;
  changingPassword.value = true;
  editing.value = false;
  removing.value = false;
  dialogError.value = "";
  password.value = "";
  confirmation.value = "";
  await nextTick();
  dialog.value?.showModal();
}
async function persist(
  next: ApiKeyRecord[],
  nextKey = key.value,
  nextSalt = salt.value,
) {
  if (!nextKey) throw Error("Unlock the vault first.");
  const envelope = await sealVault(nextKey, nextSalt, next);
  return certificateRequest<VaultState>("vault-write", {
    expectedRevision: state.value.revision,
    envelope,
  });
}
async function save() {
  if (!key.value || busy.value) return;
  dialogError.value = "";
  busy.value = true;
  const operation = epoch;
  try {
    if (changingPassword.value) {
      const inputPassword = password.value;
      if (inputPassword.length < 12 || inputPassword !== confirmation.value)
        throw Error(
          "Use at least 12 characters and enter the same password twice.",
        );
      password.value = "";
      confirmation.value = "";
      const nextSalt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
      const nextKey = await deriveVaultKey(inputPassword, nextSalt);
      if (operation !== epoch) return;
      const saved = await persist(records.value, nextKey, nextSalt);
      state.value = saved;
      if (operation !== epoch) return;
      key.value = nextKey;
      salt.value = nextSalt;
      notice.value = "Vault password changed.";
    } else {
      if (!props.environments.some((e) => e.id === draft.environmentId))
        throw Error(
          "Choose an existing environment. Add environments from the sidebar.",
        );
      const previous = records.value.find((r) => r.id === draft.id);
      const record = apiKeyRecordSchema.parse({
        ...draft,
        id: previous?.id || crypto.randomUUID(),
        createdAt: previous?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const next = removing.value
        ? records.value.filter((r) => r.id !== record.id)
        : [...records.value.filter((r) => r.id !== record.id), record];
      const saved = await persist(next);
      state.value = saved;
      if (operation !== epoch) return;
      records.value = next;
      selected.value = record.id;
      notice.value = removing.value
        ? `${singular.value} deleted.`
        : `${singular.value} saved, encrypted.`;
    }
    closeDialog();
    activity();
  } catch (e) {
    // Validation errors must not print the secret or the record being validated.
    if (operation === epoch)
      dialogError.value =
        e instanceof Error && e.name !== "ZodError"
          ? e.message
          : "Check the name, environment and value. Values can contain 1 to 16,384 characters.";
  } finally {
    busy.value = false;
  }
}
async function copySecret() {
  if (!key.value || !current.value) return;
  try {
    await navigator.clipboard.writeText(current.value.secret);
    notice.value = `${singular.value} copied to clipboard.`;
  } catch {
    error.value =
      "Clipboard access failed. Reveal the value to copy it manually.";
  }
}
function hidden() {
  if (document.hidden) lock("Vault locked while the app was hidden.");
}
onMounted(() => {
  void load();
  document.addEventListener("visibilitychange", hidden);
  document.addEventListener("pointerdown", activity, true);
  document.addEventListener("keydown", activity, true);
  idleTimer = setInterval(() => {
    if (key.value && Date.now() - lastActivity >= 5 * 60 * 1000)
      lock("Vault locked after five minutes of inactivity.");
  }, 1000);
});
onBeforeUnmount(() => {
  lock();
  clearInterval(idleTimer);
  document.removeEventListener("visibilitychange", hidden);
  document.removeEventListener("pointerdown", activity, true);
  document.removeEventListener("keydown", activity, true);
});
</script>

<template>
  <section class="api-key-vault" :aria-label="`${singular} vault`">
    <p v-if="error" class="cert-error" role="alert">
      {{ error }}
      <button
        v-if="loading === false && !key"
        class="subtle-button"
        @click="load"
      >
        Reload vault
      </button>
    </p>
    <p v-if="notice" class="cert-message" role="status">{{ notice }}</p>
    <p v-if="loading" class="cert-empty">Loading vault…</p>
    <form v-else-if="!key" class="vault-unlock" @submit.prevent="authenticate">
      <Icon name="key" :size="26" />
      <h2>
        {{ state.envelope ? `Unlock ${plural}` : "Set your vault password" }}
      </h2>
      <p>
        {{
          state.envelope
            ? "Your API keys and secrets are encrypted. Unlock them to browse by environment."
            : "One password protects your API keys and secrets across all NetSuite environments. Choose a password with at least 12 characters."
        }}
      </p>
      <label class="property"
        ><span>Vault password</span
        ><input
          v-model="password"
          aria-label="Vault password"
          type="password"
          :autocomplete="state.envelope ? 'current-password' : 'new-password'"
          required
          :minlength="state.envelope ? 1 : 12"
          maxlength="1024"
          :disabled="busy"
      /></label>
      <label v-if="!state.envelope" class="property"
        ><span>Confirm vault password</span
        ><input
          v-model="confirmation"
          aria-label="Confirm vault password"
          type="password"
          autocomplete="new-password"
          required
          minlength="12"
          maxlength="1024"
          :disabled="busy"
      /></label>
      <p v-if="!state.envelope" class="cert-help">
        Keep this password safe. It cannot be recovered or reset without losing
        access to your saved API keys and secrets.
      </p>
      <button class="cert-primary" type="submit" :disabled="busy">
        {{
          busy
            ? "Working…"
            : state.envelope
              ? "Unlock vault"
              : "Create encrypted vault"
        }}
      </button>
    </form>
    <template v-else>
      <div class="vault-actions">
        <label class="cert-search"
          ><Icon name="search" :size="14" /><input
            v-model="search"
            :aria-label="`Search ${plural}`"
            placeholder="Search name, purpose, account ID…" /></label
        ><button
          class="subtle-button"
          :disabled="busy"
          @click="openPasswordChange"
        >
          Change password</button
        ><button class="subtle-button" @click="lock('Vault locked.')">
          Lock vault</button
        ><button
          class="cert-primary"
          :disabled="busy || !environments.length"
          @click="openEditor()"
        >
          <Icon name="plus" :size="13" />Add {{ singular }}
        </button>
      </div>
      <p v-if="!environments.length" class="cert-empty">
        Add an environment from the sidebar before saving a credential.
      </p>
      <div v-else class="vault-workspace">
        <div
          class="vault-groups"
          :aria-label="`${plural} grouped by environment`"
        >
          <p v-if="!filtered.length" class="cert-empty">
            {{
              records.some((record) => (record.kind || "api-key") === kind)
                ? `No matching ${plural}. Try another environment or search.`
                : `No ${plural} yet. Add one and choose its environment.`
            }}
          </p>
          <section v-for="group in groups" :key="group.id">
            <h3 class="credential-group-title">
              {{ group.environment?.name || "Unavailable environment"
              }}<small>{{ group.environment?.accountId || group.id }}</small>
            </h3>
            <button
              v-for="record in group.records"
              :key="record.id"
              class="cert-list-item"
              :aria-pressed="current?.id === record.id"
              @click="selected = record.id"
            >
              <strong>{{ record.name }}</strong
              ><span class="cert-purpose">{{
                record.purpose || "No purpose added"
              }}</span>
            </button>
          </section>
        </div>
        <article v-if="current" class="vault-detail">
          <h2>{{ current.name }}</h2>
          <p class="cert-detail-purpose">{{ current.purpose }}</p>
          <span class="cert-tag"
            >{{
              environments.find((e) => e.id === current?.environmentId)?.name ||
              "Unavailable environment"
            }}
            ·
            {{
              environments.find((e) => e.id === current?.environmentId)
                ?.accountId
            }}</span
          >
          <h3>{{ singular }}</h3>
          <div class="vault-secret">
            <input
              :aria-label="`Saved ${singular}`"
              :type="revealed ? 'text' : 'password'"
              readonly
              :value="current.secret"
              autocomplete="off"
              spellcheck="false"
            /><button
              class="subtle-button"
              :aria-pressed="revealed"
              @click="revealed = !revealed"
            >
              {{
                revealed
                  ? isApiSecret
                    ? "Hide secret"
                    : "Hide key"
                  : isApiSecret
                    ? "Reveal secret"
                    : "Reveal key"
              }}
            </button>
          </div>
          <div class="cert-file-actions">
            <button class="subtle-button" @click="copySecret">
              <Icon name="copy" :size="13" />Copy {{ singular }}</button
            ><button
              class="subtle-button"
              :disabled="busy"
              @click="openEditor(current)"
            >
              <Icon name="edit" :size="13" />Edit {{ singular }}
            </button>
          </div>
          <p class="cert-help">
            Saved encrypted. This vault locks on reload, when hidden, or after
            five minutes of inactivity.
          </p>
          <p class="cert-help">
            Updated {{ new Date(current.updatedAt).toLocaleString() }}
          </p>
        </article>
      </div>
    </template>
    <Teleport to="body"
      ><dialog
        ref="dialog"
        class="cert-dialog vault-dialog"
        :aria-labelledby="dialogTitleId"
        @keydown.stop
        @cancel.prevent="!busy && closeDialog()"
        @close="closeDialog"
      >
        <form class="cert-dialog-content" @submit.prevent="save">
          <header>
            <h2 :id="dialogTitleId">
              {{
                changingPassword
                  ? "Change vault password"
                  : draft.id
                    ? `Edit ${singular}`
                    : `Add ${singular}`
              }}
            </h2>
            <button
              class="subtle-button"
              type="button"
              :aria-label="`Close ${singular} settings`"
              :disabled="busy"
              @click="closeDialog"
            >
              <Icon name="close" />
            </button>
          </header>
          <fieldset :disabled="busy">
            <template v-if="changingPassword"
              ><label class="property"
                ><span>New vault password</span
                ><input
                  v-model="password"
                  aria-label="New vault password"
                  type="password"
                  autocomplete="new-password"
                  required
                  minlength="12"
                  maxlength="1024" /></label
              ><label class="property"
                ><span>Confirm new password</span
                ><input
                  v-model="confirmation"
                  aria-label="Confirm new password"
                  type="password"
                  autocomplete="new-password"
                  required
                  minlength="12"
                  maxlength="1024"
              /></label>
              <p class="cert-help">
                All saved API keys and secrets will be encrypted with the new
                password.
              </p></template
            >
            <template v-else
              ><div class="cert-form-grid">
                <label class="property"
                  ><span>{{ isApiSecret ? "Secret name" : "Key name" }}</span
                  ><input
                    v-model="draft.name"
                    :aria-label="isApiSecret ? 'Secret name' : 'Key name'"
                    required
                    maxlength="160" /></label
                ><label class="property"
                  ><span>Environment</span
                  ><CustomSelect
                    v-model="draft.environmentId"
                    :teleport-to="dialog"
                    :aria-label="`${singular} environment`"
                    :options="options" /></label
                ><label class="property cert-full"
                  ><span>Purpose</span
                  ><textarea
                    v-model="draft.purpose"
                    :aria-label="`${singular} purpose`"
                    maxlength="2000"
                    rows="2"
                  /></label
                ><label class="property cert-full"
                  ><span>{{ singular }}</span
                  ><input
                    v-model="draft.secret"
                    :aria-label="`${singular} value`"
                    :type="draftVisible ? 'text' : 'password'"
                    autocomplete="off"
                    spellcheck="false"
                    required
                    maxlength="16384"
                /></label>
              </div>
              <p v-if="isApiSecret" class="cert-help">
                Enter a value of any length from 1 to 16,384 characters.
                Generating creates a random 32-character secret.
              </p>
              <button
                v-if="isApiSecret"
                type="button"
                class="subtle-button"
                @click="
                  draft.secret = generateApiSecret();
                  draftVisible = false;
                "
              >
                Generate 32-character secret
              </button>
              <button
                class="subtle-button"
                type="button"
                :aria-pressed="draftVisible"
                @click="draftVisible = !draftVisible"
              >
                {{ draftVisible ? "Hide value" : "Show value" }}</button
              ><button
                v-if="draft.id && !removing"
                class="subtle-button"
                type="button"
                @click="removing = true"
              >
                Delete {{ singular }}
              </button>
              <p v-if="removing" class="cert-error">
                Delete this {{ singular }} from the vault? This cannot be
                undone.
              </p></template
            >
          </fieldset>
          <p v-if="dialogError" class="cert-error" role="alert">
            {{ dialogError }}
          </p>
          <footer>
            <span class="cert-help">{{
              changingPassword
                ? "Your password stays on this device."
                : "The value and its metadata are encrypted before saving."
            }}</span
            ><button
              class="subtle-button"
              type="button"
              :disabled="busy"
              @click="closeDialog"
            >
              Cancel</button
            ><button class="cert-primary" type="submit" :disabled="busy">
              {{
                busy
                  ? "Saving…"
                  : changingPassword
                    ? "Change password"
                    : removing
                      ? "Confirm delete"
                      : `Save ${singular}`
              }}
            </button>
          </footer>
        </form>
      </dialog></Teleport
    >
  </section>
</template>

<style>
.api-key-vault {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.vault-unlock {
  width: min(100%, 390px);
  padding: 30px 25px;
  align-self: center;
  overflow: auto;
}
.vault-unlock h2,
.vault-detail h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 12px 0 8px;
  overflow-wrap: anywhere;
}
.vault-unlock > p {
  font-size: 12px;
  line-height: 1.7;
  color: #607482;
}
.vault-unlock .property {
  margin: 14px 0;
  font-size: 11px;
}
.vault-unlock input,
.vault-secret input {
  background: #e7eef2;
  border: 0;
  padding: 9px;
  border-radius: 4px;
  width: 100%;
  min-width: 0;
}
.vault-unlock .cert-primary {
  margin-top: 8px;
}
.vault-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.vault-actions .cert-search {
  flex: 1 1 180px;
}
.vault-actions button {
  font-size: 11px;
}
.vault-workspace {
  display: flex;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
.vault-groups {
  flex: 1;
  overflow: auto;
  min-width: 180px;
  scrollbar-gutter: stable;
}
.credential-group-title {
  font-size: 11px;
  font-weight: 600;
  margin: 0;
  padding: 14px 16px 9px;
  background: #f0f4f6;
  overflow-wrap: anywhere;
}
.credential-group-title small {
  display: block;
  margin-top: 4px;
  font-weight: 400;
  font-size: 10px;
  color: #526775;
}
.vault-detail {
  width: 46%;
  min-width: 270px;
  padding: 20px;
  border-left: 1px solid var(--line);
  overflow: auto;
  scrollbar-gutter: stable;
}
.vault-detail h2 {
  margin-top: 0;
}
.vault-detail h3 {
  font-size: 11px;
  margin: 24px 0 10px;
}
.vault-secret {
  display: flex;
  gap: 5px;
  align-items: center;
}
.vault-secret input {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.vault-secret button {
  flex: none;
  font-size: 11px;
}
.vault-dialog .property + .property {
  margin-top: 12px;
}
@container (max-width:880px) {
  .vault-workspace {
    flex-direction: column;
    overflow: auto;
  }
  .vault-groups {
    flex: none;
    max-height: 220px;
    min-height: 130px;
  }
  .vault-detail {
    width: 100%;
    min-width: 0;
    border-left: 0;
    border-top: 1px solid var(--line);
    flex: 1 0 auto;
    overflow: visible;
  }
}
</style>
