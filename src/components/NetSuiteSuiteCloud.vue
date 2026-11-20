<script setup lang="ts">
// The account's SuiteCloud workspace (the scratch SDF project agents build in)
// and the map/reduce and scheduled runs Orvane started.
import { computed, onMounted, ref } from "vue";
import CustomSelect from "./CustomSelect.vue";
import Icon from "./Icon.vue";
import { certificateRequest, type CertificateData } from "../certificates";
import { accountOf, suiteCloudStatus, workspaceCall, type SuiteCloudStatus } from "../netsuiteWorkspace";

defineOptions({ name: "NetSuiteSuiteCloud" });
const props = defineProps<{ environment: string }>();
type Run = {
  runId: string;
  name?: string;
  scriptId?: string;
  scriptType?: string;
  originalStatus?: string;
  submittedAt: string;
  state: string;
  done: boolean;
  instances: { status: string; percent?: string; stage?: string | null }[];
  restore?: { needed: boolean; restored?: boolean; status?: string; error?: string; note?: string };
  lastError?: string;
};
const account = computed(() => accountOf(props.environment));
const status = ref<SuiteCloudStatus | null>(null),
  files = ref<{ path: string; size: number }[]>([]),
  openFile = ref<{ path: string; content?: string; error?: string } | null>(null),
  runs = ref<Run[]>([]),
  output = ref(""),
  busy = ref(""),
  error = ref("");
const authOptions = computed(() => (status.value?.authIds ?? []).map((id) => ({ value: id, label: id })));
const certificateOptions = ref<{ value: string; label: string }[]>([]);
const certificatePairId = ref("");
const certificateId = ref("");
const showConnection = ref(false);
const authId = computed({
  get: () => status.value?.authId ?? "",
  set: (value: string) => void chooseAuth(value),
});
async function guard(label: string, work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = label;
  error.value = "";
  try {
    await work();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = "";
  }
}
async function loadCertificates() {
  const { environments, certificates } = await certificateRequest<CertificateData>("list");
  const accountEnvironments = new Set(environments
    .filter((env) => env.accountId.toUpperCase().replaceAll("-", "_") === account.value)
    .map((env) => env.id));
  const now = Date.now();
  certificateOptions.value = certificates
    .filter((pair) => accountEnvironments.has(pair.environmentId) && !pair.archived && Date.parse(pair.notBefore) <= now && Date.parse(pair.notAfter) > now)
    .map((pair) => ({ value: pair.id, label: pair.name }));
  if (!certificateOptions.value.some((option) => option.value === certificatePairId.value)) {
    certificatePairId.value = certificateOptions.value.length === 1 ? certificateOptions.value[0]!.value : "";
  }
}
async function loadFiles() {
  files.value = status.value?.created
    ? (await workspaceCall<{ files: typeof files.value }>("suitecloud-tree", { account: account.value })).files
    : [];
}
const load = (refresh = false) =>
  guard("Loading", async () => {
    status.value = await suiteCloudStatus(account.value, refresh);
    if (status.value.cli && (!status.value.available || showConnection.value)) await loadCertificates();
    runs.value = (await workspaceCall<{ runs: Run[] }>("task-runs", { account: account.value })).runs;
    await loadFiles();
  });
const toggleConnection = () => guard("Loading certificates", async () => {
  showConnection.value = !showConnection.value;
  if (showConnection.value) await loadCertificates();
});
const connect = () => guard("Connecting", async () => {
  if (!certificatePairId.value || !certificateId.value.trim()) return;
  status.value = await workspaceCall<SuiteCloudStatus>("suitecloud-connect", {
    account: account.value,
    certificatePairId: certificatePairId.value,
    certificateId: certificateId.value.trim(),
  });
  certificateId.value = "";
  showConnection.value = false;
  output.value = "";
  void suiteCloudStatus(account.value, true).catch(() => {});
  await loadFiles();
});
const chooseAuth = (value: string) =>
  guard("Saving", async () => {
    if (!value || value === status.value?.authId) return;
    status.value = await workspaceCall<SuiteCloudStatus>("suitecloud-auth", { account: account.value, authId: value });
    void suiteCloudStatus(account.value, true).catch(() => {});
  });
const showFile = (path: string) =>
  guard("Opening", async () => {
    openFile.value = await workspaceCall("suitecloud-file", { account: account.value, path });
  });
const deploy = (dryRun: boolean) =>
  guard(dryRun ? "Previewing" : "Deploying", async () => {
    const result = await workspaceCall<{ ok: boolean; output: string; command: string; authExpired?: string; nextStep?: string }>("suitecloud-deploy", { account: account.value, dryRun });
    output.value = `${result.ok ? "Done" : "Failed"}: ${result.command}\n\n${result.output}`;
    if (result.authExpired) {
      showConnection.value = true;
      await loadCertificates();
      error.value = result.nextStep ?? "Connect with a certificate to continue.";
    }
  });
const runLabel = (run: Run) => {
  const last = run.instances[0];
  if (!run.done) return last ? `${last.status.toLowerCase()} ${last.percent ?? ""}`.trim() : "starting";
  return run.state.replace("-", " ");
};
const restoreLabel = (run: Run) =>
  !run.restore ? (run.originalStatus && run.originalStatus !== "NOTSCHEDULED" ? `will put back ${run.originalStatus.toLowerCase()}` : "")
  : run.restore.restored ? `put back ${run.restore.status?.toLowerCase()}`
  : run.restore.error ? `restore failed: ${run.restore.error}`
  : run.restore.note ?? "";
const time = (iso: string) => new Date(iso).toLocaleString();
onMounted(() => void load());
</script>
<template>
  <div class="sc-view">
    <header class="sc-head">
      <div>
        <strong>SuiteCloud workspace</strong>
        <small>{{ account }}<template v-if="status?.cli"> · CLI {{ status.cli }}</template></small>
      </div>
      <CustomSelect v-if="authOptions.length > 1" v-model="authId" :options="authOptions" :disabled="!!busy" aria-label="SuiteCloud authentication ID" />
      <span v-else-if="status?.authId" class="sc-auth"><Icon name="key" :size="13" /> {{ status.authId }}</span>
      <button v-if="status?.available" class="subtle-button" :disabled="!!busy" :aria-expanded="showConnection" @click="toggleConnection">
        {{ showConnection ? "Hide certificate setup" : "Connect with certificate" }}
      </button>
      <button class="subtle-button" :disabled="!!busy" aria-label="Refresh SuiteCloud workspace" @click="load(true)"><Icon name="refresh" :size="13" /></button>
    </header>
    <p v-if="error" class="sc-error" role="alert">{{ error }}</p>
    <form v-if="status?.cli && (!status.available || showConnection)" class="sc-connection" @submit.prevent="connect">
      <strong>Connect with certificate</strong>
      <p v-if="!certificateOptions.length && !busy">Create a valid certificate pair for account {{ account }} in Certificate manager, then refresh this workspace.</p>
      <template v-else>
        <div class="sc-fields">
          <div class="sc-field">
            <span>Certificate pair</span>
            <CustomSelect v-model="certificatePairId" :options="certificateOptions" :disabled="!!busy" placeholder="Choose a certificate pair" aria-label="Certificate pair" />
          </div>
          <label class="sc-field">
            <span>NetSuite certificate ID</span>
            <input v-model="certificateId" type="text" maxlength="200" autocomplete="off" spellcheck="false" :disabled="!!busy" />
          </label>
          <button class="subtle-button" :disabled="!!busy || !certificatePairId || !certificateId.trim()">{{ busy === "Connecting" ? "Connecting…" : "Connect" }}</button>
        </div>
        <p>Paste the ID from NetSuite’s OAuth 2.0 Client Credentials (M2M) Setup.</p>
      </template>
    </form>
    <p v-if="status && !status.cli" class="sc-notice">{{ status.reason }}</p>
    <div v-else class="sc-body">
      <section class="sc-files" aria-label="Project files">
        <div class="sc-section-head">
          <strong>Project</strong>
          <span class="sc-actions">
            <button class="subtle-button" :disabled="!!busy || !status?.available || showConnection" @click="deploy(true)">Preview deploy</button>
            <button class="subtle-button" :disabled="!!busy || !status?.available || showConnection" @click="deploy(false)"><Icon name="upload" :size="13" /> Deploy</button>
          </span>
        </div>
        <p v-if="busy" class="sc-muted">{{ busy }}…</p>
        <p v-if="status && !files.length && !busy" class="sc-muted">{{ status.available ? "Empty. Agents build here with orvane_netsuite_sdf; it is created on first use." : "No project files yet." }}</p>
        <ul class="sc-tree">
          <li v-for="file in files" :key="file.path">
            <button :class="{ active: openFile?.path === file.path }" @click="showFile(file.path)"><Icon :name="file.path.startsWith('Objects/') ? 'box' : 'file'" :size="13" /> {{ file.path }}</button>
          </li>
        </ul>
      </section>
      <section class="sc-preview" aria-label="File or deploy output">
        <pre v-if="output" class="sc-output">{{ output }}</pre>
        <template v-else-if="openFile">
          <div class="sc-section-head"><strong>{{ openFile.path }}</strong></div>
          <pre class="sc-output">{{ openFile.content ?? openFile.error }}</pre>
        </template>
        <p v-else class="sc-muted">Select a file to read it.</p>
      </section>
      <section class="sc-runs" aria-label="Task runs">
        <div class="sc-section-head"><strong>Runs started by Orvane</strong></div>
        <p v-if="!runs.length" class="sc-muted">None yet. Agents start map/reduce and scheduled deployments with orvane_netsuite_task.</p>
        <table v-else>
          <thead><tr><th>Deployment</th><th>Started</th><th>State</th><th>Status</th></tr></thead>
          <tbody>
            <tr v-for="run in runs" :key="run.runId">
              <td><strong>{{ run.name ?? run.scriptId }}</strong><small>{{ run.scriptId }}</small></td>
              <td>{{ time(run.submittedAt) }}</td>
              <td :class="{ failed: run.state === 'failed' }">{{ runLabel(run) }}<small v-if="run.lastError">{{ run.lastError }}</small></td>
              <td>{{ restoreLabel(run) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>
<style scoped>
.sc-view { height: 100%; display: flex; flex-direction: column; min-height: 0; color: #455968; font-size: 12px; }
.sc-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #e3e8eb; }
.sc-head > div { display: flex; flex-direction: column; margin-right: auto; }
.sc-head small, .sc-muted, td small { color: #7d8f9b; }
.sc-auth { display: inline-flex; align-items: center; gap: 4px; }
.sc-notice, .sc-error { margin: 12px 14px; }
.sc-error { color: #a2453c; }
.sc-connection { padding: 10px 14px; border-bottom: 1px solid #e3e8eb; }
.sc-connection p { margin: 6px 0 0; }
.sc-fields { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; margin-top: 8px; }
.sc-field { flex: 1 1 170px; min-width: 0; max-width: 300px; display: grid; gap: 4px; }
.sc-field input { min-width: 0; height: 28px; padding: 0 8px; border: 1px solid #c5d0d7; border-radius: 6px; background: #f7f9fa; color: inherit; font: inherit; }
.sc-field input:focus-visible { outline: 2px solid #6f8998; outline-offset: 1px; }
.sc-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(180px, 30%) 1fr; grid-template-rows: 1fr minmax(120px, 34%); }
.sc-files { grid-row: 1; border-right: 1px solid #e3e8eb; overflow: auto; }
.sc-preview { grid-row: 1; overflow: auto; min-width: 0; }
.sc-runs { grid-column: 1 / -1; border-top: 1px solid #e3e8eb; overflow: auto; }
.sc-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; }
.sc-actions { display: flex; gap: 6px; }
.sc-muted { margin: 4px 12px; }
.sc-tree { list-style: none; margin: 0; padding: 0 6px 8px; }
.sc-tree button { width: 100%; display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.sc-tree button:hover, .sc-tree button.active { background: #e9edf0; }
.sc-output { margin: 0 12px 12px; padding: 10px; border-radius: 8px; background: #eef2f4; font: 12px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; }
th { position: static; text-align: left; font-weight: 600; padding: 6px 12px; background: #f7f9fa; border-bottom: 1px solid #e3e8eb; }
td { padding: 6px 12px; border-bottom: 1px solid #eef1f3; vertical-align: top; }
td small { display: block; }
td.failed { color: #a2453c; }
</style>
