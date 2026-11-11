<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
} from "vue";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
import ApiKeyVault from "./ApiKeyVault.vue";
import {
  certificateRequest,
  type CertificateData,
  type CertificateEnvironment,
  type CertificateRecord,
} from "../certificates";

const data = ref<CertificateData>({ environments: [], certificates: [] });
const loading = ref(true),
  busy = ref(false),
  error = ref(""),
  dialogError = ref(""),
  message = ref("");
const search = ref(""),
  environment = ref(""),
  selected = ref(""),
  archived = ref(false);
const credentialTab = ref<"certificates" | "api-keys" | "api-secrets">(
  "certificates",
);
const dialog = ref<HTMLDialogElement>(),
  mode = ref<"generate" | "environments">("generate");
const dialogTitleId = `certificate-settings-${crypto.randomUUID()}`;
const addingEnvironment = ref(false),
  envBusy = ref(false);
const envDraft = reactive({ id: "", name: "", accountId: "" });
const duration = ref("12");
const draft = reactive({
  name: "",
  purpose: "",
  environmentId: "",
  commonName: "AgentConsole",
  bits: "4096",
  hash: "sha256",
  notBefore: "",
  notAfter: "",
  certFilename: "rsapss-cert.pem",
  keyFilename: "rsapss-key.pem",
});
const envName = (id: string) =>
  data.value.environments.find((e) => e.id === id);
const environmentOptions = computed(() =>
  data.value.environments.map((e) => ({
    value: e.id,
    label: `${e.name} · ${e.accountId}`,
  })),
);
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return data.value.certificates
    .filter(
      (c) =>
        c.archived === archived.value &&
        (!environment.value || c.environmentId === environment.value) &&
        [
          c.name,
          c.purpose,
          c.commonName,
          envName(c.environmentId)?.name,
          envName(c.environmentId)?.accountId,
          c.fingerprint,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});
const current = computed(
  () =>
    filtered.value.find((c) => c.id === selected.value) || filtered.value[0],
);
const certificateGroups = computed(() =>
  [...new Set(filtered.value.map((c) => c.environmentId))]
    .map((id) => ({
      id,
      environment: envName(id),
      certificates: filtered.value.filter((c) => c.environmentId === id),
    }))
    .sort((a, b) =>
      (a.environment?.name || "").localeCompare(b.environment?.name || ""),
    ),
);
const formatDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
function status(c: CertificateRecord) {
  if (Date.parse(c.notAfter) < Date.now()) return "Expired";
  if (Date.parse(c.notBefore) > Date.now()) return "Not yet valid";
  return Date.parse(c.notAfter) - Date.now() < 30 * 86400000
    ? "Expires soon"
    : "Valid";
}
function localDate(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function setDuration() {
  if (!draft.notBefore || !duration.value) return;
  const start = new Date(draft.notBefore);
  const day = start.getDate();
  start.setDate(1);
  start.setMonth(start.getMonth() + Number(duration.value));
  const endOfMonth = new Date(
    start.getFullYear(),
    start.getMonth() + 1,
    0,
  ).getDate();
  start.setDate(Math.min(day, endOfMonth));
  draft.notAfter = localDate(start);
}
async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    data.value = await certificateRequest<CertificateData>("list");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}
function resetEnvironment(env?: CertificateEnvironment) {
  Object.assign(envDraft, env || { id: "", name: "", accountId: "" });
}
async function openDialog(
  next: "generate" | "environments",
  reuse?: CertificateRecord,
) {
  mode.value = next;
  dialogError.value = "";
  message.value = "";
  resetEnvironment();
  addingEnvironment.value = !data.value.environments.length;
  if (next === "generate") {
    Object.assign(draft, {
      name: reuse ? `${reuse.name} (renewal)` : "",
      purpose: reuse?.purpose || "",
      environmentId:
        reuse?.environmentId ||
        environment.value ||
        data.value.environments[0]?.id ||
        "",
      commonName: reuse?.commonName || "AgentConsole",
      bits: String(reuse?.bits || 4096),
      hash: reuse?.hash || "sha256",
      notBefore: localDate(new Date()),
      certFilename: reuse?.certFilename || "rsapss-cert.pem",
      keyFilename: reuse?.keyFilename || "rsapss-key.pem",
    });
    duration.value = "12";
    setDuration();
  }
  await nextTick();
  dialog.value?.showModal();
}
function closeDialog() {
  if (!busy.value && !envBusy.value) dialog.value?.close();
}
async function saveEnvironment() {
  if (envBusy.value) return;
  envBusy.value = true;
  dialogError.value = "";
  try {
    const before = new Set(data.value.environments.map((e) => e.id));
    data.value = await certificateRequest<CertificateData>("environment-save", {
      ...envDraft,
      id: envDraft.id || undefined,
    });
    if (mode.value === "generate") {
      draft.environmentId =
        envDraft.id ||
        data.value.environments.find((e) => !before.has(e.id))?.id ||
        "";
      addingEnvironment.value = false;
    }
    resetEnvironment();
    message.value = "Environment saved.";
  } catch (e) {
    dialogError.value = e instanceof Error ? e.message : String(e);
  } finally {
    envBusy.value = false;
  }
}
async function generate() {
  if (busy.value || envBusy.value) return;
  dialogError.value = "";
  if (!draft.environmentId) {
    dialogError.value = "Create or select an environment first.";
    return;
  }
  if (
    !draft.notBefore ||
    !draft.notAfter ||
    new Date(draft.notAfter) <= new Date(draft.notBefore)
  ) {
    dialogError.value = "Choose an expiry after the start date.";
    return;
  }
  busy.value = true;
  try {
    const before = new Set(data.value.certificates.map((c) => c.id));
    data.value = await certificateRequest<CertificateData>("generate", {
      ...draft,
      bits: Number(draft.bits),
      notBefore: new Date(draft.notBefore).toISOString(),
      notAfter: new Date(draft.notAfter).toISOString(),
    });
    selected.value =
      data.value.certificates.find((c) => !before.has(c.id))?.id || "";
    environment.value = draft.environmentId;
    archived.value = false;
    search.value = "";
    dialog.value?.close();
    message.value = "Certificate and private key generated and saved.";
  } catch (e) {
    dialogError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function reveal(file: "certificate" | "key" | "folder") {
  if (!current.value) return;
  error.value = "";
  try {
    await certificateRequest("reveal", { id: current.value.id, file });
    message.value =
      file === "folder"
        ? "Opened the pair folder in Explorer."
        : `Opened Explorer for ${file === "key" ? current.value.keyFilename : current.value.certFilename}.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function archive() {
  if (!current.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    data.value = await certificateRequest<CertificateData>("archive", {
      id: current.value.id,
      archived: !current.value.archived,
    });
    message.value = archived.value
      ? "Pair restored."
      : "Pair archived. Both files are kept.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    message.value = "Path copied.";
  } catch {
    error.value =
      "Could not copy the path. Select and copy it from the file details.";
  }
}
onMounted(refresh);
onBeforeUnmount(() => dialog.value?.close());
</script>

<template>
  <section class="certificate-manager" aria-label="Certificate manager">
    <header class="cert-toolbar">
      <div class="cert-title">
        <Icon name="key" :size="18" /><strong
          >Certificates & API credentials</strong
        ><span>{{ data.certificates.length }} certificates</span>
      </div>
      <div class="cert-toolbar-actions">
        <button
          class="subtle-button"
          :disabled="loading || busy"
          aria-label="Refresh certificates"
          title="Refresh"
          @click="refresh"
        >
          <Icon name="refresh" :size="14" />
        </button>
        <button
          v-if="credentialTab === 'certificates'"
          class="cert-primary"
          :disabled="loading"
          @click="openDialog('generate')"
        >
          <Icon name="plus" :size="14" />New certificate
        </button>
      </div>
    </header>
    <div class="cert-layout">
      <aside class="cert-environments">
        <div class="cert-section-title">
          <strong>Environments</strong
          ><button
            aria-label="Manage environments"
            title="Manage environments"
            @click="openDialog('environments')"
          >
            <Icon name="settings" :size="14" />
          </button>
        </div>
        <nav aria-label="Filter by NetSuite environment">
          <button :aria-pressed="environment === ''" @click="environment = ''">
            <Icon name="layers" :size="14" /><span>All environments</span>
          </button>
          <button
            v-for="env in data.environments"
            :key="env.id"
            :aria-pressed="environment === env.id"
            @click="environment = env.id"
          >
            <Icon name="globe" :size="14" /><span
              >{{ env.name }}<small>{{ env.accountId }}</small></span
            >
          </button>
        </nav>
        <button
          class="subtle-button cert-add-environment"
          @click="openDialog('environments')"
        >
          <Icon name="plus" :size="13" />Add environment
        </button>
        <p class="cert-storage-note">
          Saved on this computer.<br />PEM files are local. API keys and secrets
          are password encrypted.
        </p>
      </aside>
      <div class="credential-content">
        <nav class="credential-tabs" aria-label="Credential types">
          <button
            :aria-pressed="credentialTab === 'certificates'"
            @click="credentialTab = 'certificates'"
          >
            Certificates</button
          ><button
            :aria-pressed="credentialTab === 'api-keys'"
            @click="credentialTab = 'api-keys'"
          >
            API keys
          </button>
          <button
            :aria-pressed="credentialTab === 'api-secrets'"
            @click="credentialTab = 'api-secrets'"
          >
            API secrets
          </button>
        </nav>
        <div v-show="credentialTab === 'certificates'" class="cert-main">
          <div class="cert-filters">
            <label class="cert-search"
              ><Icon name="search" :size="14" /><input
                v-model="search"
                aria-label="Search certificates"
                placeholder="Search name, purpose, account ID…"
            /></label>
            <button
              class="subtle-button"
              :aria-pressed="archived"
              @click="archived = !archived"
            >
              <Icon name="archive" :size="13" />{{
                archived ? "Archived" : "Active"
              }}
            </button>
          </div>
          <p v-if="error" class="cert-error" role="alert">
            {{ error }}
            <button class="subtle-button" @click="refresh">Retry</button>
          </p>
          <p v-if="message" class="cert-message" role="status">{{ message }}</p>
          <div class="cert-workspace">
            <div
              class="cert-list"
              aria-label="Saved certificate pairs"
              :aria-busy="loading"
            >
              <p v-if="loading" class="cert-empty">Loading certificates…</p>
              <div v-else-if="!filtered.length" class="cert-empty">
                <Icon name="key" :size="25" /><strong>{{
                  data.certificates.length
                    ? "No matching certificates"
                    : "Your certificate pairs live here"
                }}</strong>
                <p>
                  {{
                    data.certificates.length
                      ? "Try another environment or search, or switch Active / Archived."
                      : "Add a NetSuite environment, then generate a pair for its purpose."
                  }}
                </p>
              </div>
              <section
                v-for="group in certificateGroups"
                v-else
                :key="group.id"
              >
                <h3 class="credential-group-title">
                  {{ group.environment?.name || "Unavailable environment"
                  }}<small>{{ group.environment?.accountId }}</small>
                </h3>
                <button
                  v-for="cert in group.certificates"
                  :key="cert.id"
                  class="cert-list-item"
                  :aria-pressed="current?.id === cert.id"
                  @click="selected = cert.id"
                >
                  <span class="cert-list-heading"
                    ><strong>{{ cert.name }}</strong
                    ><span
                      class="cert-status"
                      :class="{
                        'cert-status-warning': status(cert) !== 'Valid',
                      }"
                      >{{ status(cert) }}</span
                    ></span
                  >
                  <span class="cert-purpose">{{ cert.purpose }}</span
                  ><span class="cert-tag"
                    >{{ envName(cert.environmentId)?.name }} ·
                    {{ envName(cert.environmentId)?.accountId }}</span
                  ><small>Expires {{ formatDate(cert.notAfter) }}</small>
                </button>
              </section>
            </div>
            <article v-if="current" class="cert-detail">
              <div class="cert-detail-heading">
                <h2>{{ current.name }}</h2>
                <span
                  class="cert-status"
                  :class="{
                    'cert-status-warning': status(current) !== 'Valid',
                  }"
                  >{{ status(current) }}</span
                >
              </div>
              <p class="cert-detail-purpose">{{ current.purpose }}</p>
              <span class="cert-tag"
                >{{ envName(current.environmentId)?.name }} ·
                {{ envName(current.environmentId)?.accountId }}</span
              >
              <h3>Files</h3>
              <div class="cert-file">
                <Icon name="file" :size="17" />
                <div>
                  <strong>Certificate</strong
                  ><span>{{ current.certFilename }}</span>
                </div>
                <button
                  class="subtle-button"
                  title="Reveal certificate in Explorer"
                  @click="reveal('certificate')"
                >
                  <Icon name="folder-open" :size="14" />Reveal
                </button>
              </div>
              <div class="cert-file">
                <Icon name="key" :size="17" />
                <div>
                  <strong>Private key</strong
                  ><span>{{ current.keyFilename }}</span>
                </div>
                <button
                  class="subtle-button"
                  title="Reveal private key in Explorer"
                  @click="reveal('key')"
                >
                  <Icon name="folder-open" :size="14" />Reveal
                </button>
              </div>
              <div class="cert-file-actions">
                <button class="subtle-button" @click="reveal('folder')">
                  <Icon name="folder" :size="13" />Open pair folder</button
                ><button
                  class="subtle-button"
                  @click="copyPath(current.keyPath)"
                >
                  Copy key path
                </button>
              </div>
              <details class="cert-paths">
                <summary>File paths</summary>
                <p>{{ current.certPath }}</p>
                <p>{{ current.keyPath }}</p>
                <button
                  class="subtle-button"
                  @click="copyPath(current.certPath)"
                >
                  Copy certificate path
                </button>
              </details>
              <h3>Certificate settings</h3>
              <dl class="cert-metadata">
                <dt>Common name</dt>
                <dd>{{ current.commonName }}</dd>
                <dt>Signature</dt>
                <dd>
                  RSA-PSS ·
                  {{ current.hash.toUpperCase().replace("SHA", "SHA-") }}
                </dd>
                <dt>Key size</dt>
                <dd>{{ current.bits }} bits · PKCS#8</dd>
                <dt>Valid from</dt>
                <dd>{{ formatDate(current.notBefore) }}</dd>
                <dt>Valid until</dt>
                <dd>{{ formatDate(current.notAfter) }}</dd>
                <dt>Usage</dt>
                <dd>Digital signature · CA: false</dd>
                <dt>SHA-256 fingerprint</dt>
                <dd class="cert-fingerprint">{{ current.fingerprint }}</dd>
              </dl>
              <footer class="cert-detail-footer">
                <button
                  class="subtle-button"
                  @click="openDialog('generate', current)"
                >
                  <Icon name="plus" :size="13" />Generate renewal</button
                ><button
                  class="subtle-button"
                  :disabled="busy"
                  @click="archive"
                >
                  <Icon name="archive" :size="13" />{{
                    current.archived ? "Restore pair" : "Archive pair"
                  }}
                </button>
              </footer>
            </article>
          </div>
        </div>
        <ApiKeyVault
          v-show="credentialTab !== 'certificates'"
          :active="credentialTab !== 'certificates'"
          :kind="credentialTab === 'api-secrets' ? 'api-secret' : 'api-key'"
          :environments="data.environments"
          :environment-id="environment"
        />
      </div>
    </div>
    <Teleport to="body">
      <dialog
        ref="dialog"
        class="cert-dialog"
        :aria-labelledby="dialogTitleId"
        @keydown.stop
        @cancel="(busy || envBusy) && $event.preventDefault()"
        @click="$event.target === dialog && closeDialog()"
      >
        <div class="cert-dialog-content">
          <header>
            <div>
              <h2 :id="dialogTitleId">
                {{
                  mode === "generate"
                    ? "New certificate pair"
                    : "NetSuite environments"
                }}
              </h2>
              <p>
                {{
                  mode === "generate"
                    ? "Choose the settings for this certificate and private key."
                    : "Reusable tags keep every pair connected to the right account."
                }}
              </p>
            </div>
            <button
              class="subtle-button"
              aria-label="Close certificate settings"
              :disabled="busy || envBusy"
              @click="closeDialog"
            >
              <Icon name="close" />
            </button>
          </header>
          <form
            v-if="mode === 'generate'"
            id="cert-generation"
            @submit.prevent="generate"
          >
            <fieldset :disabled="busy || envBusy">
              <legend>Identity & purpose</legend>
              <div class="cert-form-grid">
                <label class="property"
                  ><span>Pair name</span
                  ><input
                    v-model="draft.name"
                    required
                    maxlength="160"
                    placeholder="e.g. Agent Console integration"
                    autofocus /></label
                ><label class="property"
                  ><span>NetSuite environment</span
                  ><CustomSelect
                    :teleport-to="dialog"
                    v-model="draft.environmentId"
                    aria-label="Certificate environment"
                    :options="environmentOptions"
                    placeholder="Select an environment" /></label
                ><label class="property cert-full"
                  ><span>Purpose</span
                  ><textarea
                    v-model="draft.purpose"
                    required
                    maxlength="2000"
                    rows="2"
                    placeholder="What will use this pair?"
                  />
                </label>
              </div>
              <button
                type="button"
                class="subtle-button"
                @click="
                  addingEnvironment = !addingEnvironment;
                  resetEnvironment();
                "
              >
                <Icon name="plus" :size="12" />{{
                  addingEnvironment
                    ? "Cancel new environment"
                    : "New environment"
                }}
              </button>
            </fieldset>
            <fieldset :disabled="busy || envBusy">
              <legend>Generation settings</legend>
              <div class="cert-form-grid">
                <label class="property"
                  ><span>Common name (CN)</span
                  ><input
                    v-model="draft.commonName"
                    required
                    maxlength="64" /></label
                ><label class="property"
                  ><span>RSA key size</span
                  ><CustomSelect
                    :teleport-to="dialog"
                    v-model="draft.bits"
                    aria-label="RSA key size"
                    :options="
                      ['2048', '3072', '4096', '8192'].map((value) => ({
                        value,
                        label: `${value} bits`,
                      }))
                    " /></label
                ><label class="property"
                  ><span>Signature hash</span
                  ><CustomSelect
                    :teleport-to="dialog"
                    v-model="draft.hash"
                    aria-label="Signature hash"
                    :options="[
                      { value: 'sha256', label: 'SHA-256' },
                      { value: 'sha384', label: 'SHA-384' },
                      { value: 'sha512', label: 'SHA-512' },
                    ]" /></label
                ><label class="property"
                  ><span>Validity preset</span
                  ><CustomSelect
                    :teleport-to="dialog"
                    v-model="duration"
                    aria-label="Validity preset"
                    :options="[
                      { value: '3', label: '3 months' },
                      { value: '6', label: '6 months' },
                      { value: '12', label: '1 year' },
                      { value: '24', label: '2 years' },
                      { value: '', label: 'Custom dates' },
                    ]"
                    @change="setDuration" /></label
                ><label class="property"
                  ><span>Valid from</span
                  ><input
                    v-model="draft.notBefore"
                    type="datetime-local"
                    required
                    @change="setDuration" /></label
                ><label class="property"
                  ><span>Valid until</span
                  ><input
                    v-model="draft.notAfter"
                    type="datetime-local"
                    required
                    @input="duration = ''" /></label
                ><label class="property"
                  ><span>Certificate filename</span
                  ><input
                    v-model="draft.certFilename"
                    required
                    pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,79}\.pem" /></label
                ><label class="property"
                  ><span>Private key filename</span
                  ><input
                    v-model="draft.keyFilename"
                    required
                    pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,79}\.pem"
                /></label>
              </div>
              <p class="cert-help">
                Self-signed · RSA-PSS · digitalSignature · CA: false. Private
                key: unencrypted PKCS#8 PEM, stored in a folder restricted to
                your OS account and Windows SYSTEM.
              </p>
            </fieldset>
          </form>
          <div v-else class="cert-environment-editor">
            <div class="cert-environment-rows">
              <button
                v-for="env in data.environments"
                :key="env.id"
                @click="resetEnvironment(env)"
              >
                <span
                  ><strong>{{ env.name }}</strong
                  ><small>{{ env.accountId }}</small></span
                ><Icon name="edit" :size="14" />
              </button>
            </div>
            <button class="subtle-button" @click="resetEnvironment()">
              <Icon name="plus" :size="12" />New environment
            </button>
          </div>
          <form
            v-if="mode === 'environments' || addingEnvironment"
            class="cert-env-form"
            @submit.prevent="saveEnvironment"
          >
            <fieldset :disabled="busy || envBusy">
              <legend>
                {{ envDraft.id ? "Edit environment" : "Add environment" }}
              </legend>
              <div class="cert-form-grid">
                <label class="property"
                  ><span>Environment name</span
                  ><input
                    v-model="envDraft.name"
                    aria-label="Environment name"
                    required
                    maxlength="160"
                    placeholder="e.g. Acme Sandbox" /></label
                ><label class="property"
                  ><span>Account ID</span
                  ><input
                    v-model="envDraft.accountId"
                    aria-label="Account ID"
                    required
                    maxlength="80"
                    pattern="[a-zA-Z0-9_\-]+"
                    placeholder="e.g. 1234567_SB1"
                /></label>
              </div>
              <button class="subtle-button" type="submit">
                {{ envBusy ? "Saving…" : "Save environment" }}
              </button>
            </fieldset>
          </form>
          <p v-if="dialogError" class="cert-error" role="alert">
            {{ dialogError }}
          </p>
          <p
            v-if="mode === 'environments' && message"
            class="cert-message"
            role="status"
          >
            {{ message }}
          </p>
          <footer>
            <span v-if="busy" role="status"
              >Generating and saving the pair…</span
            ><span v-else class="cert-help">{{
              mode === "generate"
                ? "Creates two new files. Existing pairs are kept."
                : `${data.environments.length} environments saved`
            }}</span
            ><button
              type="button"
              class="subtle-button"
              :disabled="busy || envBusy"
              @click="closeDialog"
            >
              {{ mode === "generate" ? "Cancel" : "Done" }}</button
            ><button
              v-if="mode === 'generate'"
              type="submit"
              form="cert-generation"
              class="cert-primary"
              :disabled="
                busy || envBusy || addingEnvironment || !draft.environmentId
              "
            >
              {{ busy ? "Generating…" : "Generate & save pair" }}
            </button>
          </footer>
        </div>
      </dialog>
    </Teleport>
  </section>
</template>

<style>
.app-content:has(> .block-certificates:only-child) {
  padding: 0;
  gap: 0;
  overflow: hidden;
}
.app-content > .block-certificates {
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.block-certificates:not(:only-child) {
  min-height: 480px;
}
.certificate-manager {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  background: var(--surface);
  color: #455968;
}
.cert-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.cert-title,
.cert-toolbar-actions,
.cert-section-title,
.cert-list-heading,
.cert-detail-heading,
.cert-file-actions,
.cert-detail-footer,
.cert-dialog-content > header,
.cert-dialog-content > footer {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cert-title strong {
  font-size: 14px;
  font-weight: 600;
}
.cert-title > span {
  font-size: 11px;
  color: #607482;
}
.cert-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 11px;
  border-radius: 6px;
  background: #496777;
  color: #fff;
  font-weight: 550;
  font-size: 12px;
}
.cert-primary:hover {
  background: #3b5868;
}
.cert-layout {
  display: grid;
  grid-template-columns: 206px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
}
.cert-environments {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--line);
  padding: 16px 10px 12px;
  background: #f0f4f6;
}
.cert-section-title {
  justify-content: space-between;
  padding: 0 7px 10px;
  font-size: 11px;
}
.cert-section-title button {
  padding: 4px;
  border-radius: 4px;
}
.cert-environments nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: auto;
  min-height: 0;
}
.cert-environments nav button {
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 10px 8px;
  border-radius: 5px;
  text-align: left;
  min-width: 0;
  font-size: 12px;
}
.cert-environments nav button > span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.cert-environments small {
  display: block;
  font-size: 10px;
  margin-top: 4px;
  color: #526775;
  font-variant-numeric: tabular-nums;
}
.cert-environments button:hover,
.cert-environment-rows button:hover {
  background: #e6edf1;
}
.cert-environments nav button[aria-pressed="true"] {
  background: #dce6ec;
  color: #304f60;
}
.cert-add-environment {
  margin-top: 12px;
  align-self: start;
}
.cert-storage-note {
  font-size: 10px;
  color: #526775;
  line-height: 1.7;
  padding: 20px 7px 0;
  margin-top: auto;
}
.cert-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.credential-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.credential-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
.credential-tabs button {
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 12px;
}
.credential-tabs button:hover {
  background: #edf2f5;
}
.credential-tabs button[aria-pressed="true"] {
  background: #e1e9ee;
  color: #304f60;
  font-weight: 550;
}
.cert-filters {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  align-items: center;
}
.cert-search {
  display: flex;
  gap: 8px;
  flex: 1;
  align-items: center;
  min-width: 0;
}
.cert-search input {
  background: transparent;
  border: 0;
  min-width: 0;
  width: 100%;
  padding: 7px 3px;
  font-size: 12px;
}
.cert-filters button[aria-pressed="true"] {
  background: #dce6ec;
}
.cert-workspace {
  display: flex;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}
.cert-list {
  flex: 1;
  overflow: auto;
  min-width: 200px;
  padding: 6px 0;
  scrollbar-gutter: stable;
}
.cert-list-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  padding: 14px 16px;
  border-bottom: 1px solid #e5ebee;
}
.cert-list-item:hover {
  background: #edf2f5;
}
.cert-list-item[aria-pressed="true"] {
  background: #e5edf2;
}
.cert-list-heading {
  justify-content: space-between;
  width: 100%;
  align-items: start;
  gap: 10px;
}
.cert-list-heading strong {
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.cert-purpose {
  font-size: 11px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.cert-tag {
  display: inline-block;
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
  border-radius: 4px;
  background: #e1e9ee;
  padding: 3px 6px;
  color: #405f70;
  font-size: 10px;
  line-height: 1.5;
}
.cert-list-item small {
  font-size: 10px;
  color: #607482;
}
.cert-status {
  flex-shrink: 0;
  font-size: 10px;
  color: #32634f;
  background: #e0ede5;
  border-radius: 4px;
  padding: 3px 6px;
  white-space: nowrap;
}
.cert-status-warning {
  color: #83581c;
  background: #f2e8d8;
}
.cert-detail {
  width: 46%;
  min-width: 290px;
  padding: 20px;
  border-left: 1px solid var(--line);
  overflow: auto;
  scrollbar-gutter: stable;
}
.cert-detail-heading {
  align-items: start;
  justify-content: space-between;
}
.cert-detail h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.cert-detail-purpose {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
  margin: 10px 0;
}
.cert-detail h3 {
  font-size: 11px;
  margin: 26px 0 9px;
  font-weight: 600;
}
.cert-file {
  display: flex;
  gap: 9px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.cert-file > div {
  flex: 1;
  min-width: 0;
}
.cert-file strong,
.cert-file span {
  display: block;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.cert-file strong {
  font-weight: 550;
}
.cert-file span {
  margin-top: 4px;
  color: #607482;
  font-size: 10px;
}
.cert-file-actions {
  gap: 3px;
  flex-wrap: wrap;
  margin: 8px -6px 0;
}
.cert-paths {
  margin-top: 10px;
  font-size: 10px;
}
.cert-paths summary {
  cursor: pointer;
  width: fit-content;
  padding: 3px 0;
}
.cert-paths p {
  overflow-wrap: anywhere;
  user-select: text;
  line-height: 1.6;
}
.cert-metadata {
  display: grid;
  grid-template-columns: 105px minmax(0, 1fr);
  font-size: 11px;
  gap: 10px 12px;
  line-height: 1.5;
  margin: 0;
}
.cert-metadata dt {
  color: #607482;
}
.cert-metadata dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.cert-fingerprint {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  user-select: text;
}
.cert-detail-footer {
  margin-top: 26px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
  gap: 3px;
}
.cert-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 40px 25px;
  color: #607482;
  gap: 13px;
  line-height: 1.6;
  font-size: 12px;
}
.cert-empty strong {
  color: #455968;
  font-size: 13px;
  font-weight: 550;
}
.cert-empty p {
  margin: 0;
  max-width: 36ch;
}
.cert-error {
  color: #8e4539;
  background: #f8eeeb;
  padding: 10px 14px;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.cert-message {
  padding: 9px 16px;
  margin: 0;
  color: #35624e;
  background: #e9f1ec;
  font-size: 11px;
}
.cert-dialog {
  padding: 0;
  border: 0;
  border-radius: 10px;
  background: #f7f9fa;
  color: #455968;
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100dvh - 40px);
  box-shadow: 0 20px 70px -18px #263e5555;
}
.cert-dialog::backdrop {
  background: #23374650;
}
.cert-dialog-content {
  padding: 22px;
}
.cert-dialog-content > header {
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 22px;
}
.cert-dialog h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.cert-dialog header p {
  font-size: 12px;
  line-height: 1.6;
  margin: 7px 0 0;
  color: #607482;
}
.cert-dialog fieldset {
  padding: 0;
  border: 0;
  margin: 0 0 20px;
  min-width: 0;
}
.cert-dialog legend {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 12px;
}
.cert-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.cert-full {
  grid-column: 1/-1;
}
.cert-dialog .property {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  min-width: 0;
}
.cert-dialog input,
.cert-dialog textarea {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  border: 0;
  border-radius: 4px;
  padding: 9px;
  background: #eaf0f3;
  font-size: 12px;
  box-shadow: inset 0 -1px #d4dfe5;
}
.cert-dialog textarea {
  resize: vertical;
  line-height: 1.5;
}
.cert-dialog .select-trigger {
  width: 100%;
}
.cert-help {
  color: #607482;
  font-size: 10px;
  line-height: 1.7;
}
.cert-dialog fieldset > .subtle-button {
  margin-top: 8px;
}
.cert-dialog-content > footer {
  border-top: 1px solid var(--line);
  padding-top: 16px;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
}
.cert-dialog-content > footer > span {
  flex: 1;
}
.cert-dialog .cert-error,
.cert-dialog .cert-message {
  margin: 0 0 14px;
  border-radius: 5px;
}
.cert-env-form {
  background: #edf2f5;
  padding: 15px;
  border-radius: 6px;
  margin-bottom: 18px;
}
.cert-env-form fieldset {
  margin: 0;
}
.cert-environment-rows {
  max-height: 180px;
  overflow: auto;
}
.cert-environment-rows button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px;
  width: 100%;
  text-align: left;
  border-bottom: 1px solid var(--line);
}
.cert-environment-rows strong,
.cert-environment-rows small {
  display: block;
  font-size: 12px;
}
.cert-environment-rows small {
  margin-top: 4px;
  font-size: 10px;
  color: #607482;
}
.cert-environment-editor {
  margin-bottom: 16px;
}
@container (max-width: 880px) {
  .cert-layout {
    grid-template-columns: 165px minmax(0, 1fr);
  }
  .cert-workspace {
    flex-direction: column;
    overflow: auto;
  }
  .cert-list {
    flex: none;
    max-height: 210px;
    min-height: 130px;
  }
  .cert-detail {
    border-left: 0;
    border-top: 1px solid var(--line);
    width: 100%;
    min-width: 0;
    flex: 1 0 auto;
    overflow: visible;
  }
  .cert-list-heading {
    align-items: center;
  }
  .cert-purpose {
    -webkit-line-clamp: 1;
  }
}
@container (max-width: 650px) {
  .cert-layout {
    grid-template-columns: 140px minmax(0, 1fr);
  }
  .cert-title > span {
    display: none;
  }
  .cert-toolbar {
    padding: 10px;
  }
  .cert-filters {
    padding: 9px;
    gap: 5px;
  }
  .cert-search input {
    font-size: 11px;
  }
  .cert-storage-note {
    display: none;
  }
}
@media (max-width: 540px) {
  .cert-form-grid {
    grid-template-columns: 1fr;
  }
  .cert-dialog-content {
    padding: 16px;
  }
  .cert-dialog-content > footer > span {
    flex-basis: 100%;
  }
}
@media (prefers-reduced-motion: no-preference) {
  .cert-dialog[open] {
    animation: cert-dialog-in 150ms ease-out;
  }
  @keyframes cert-dialog-in {
    from {
      opacity: 0.7;
      transform: translateY(5px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}
</style>
