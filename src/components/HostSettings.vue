<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { agentRequest } from "../exposition";
import { hostPasswordMaximum, hostPasswordMinimum } from "../hostPassword";
import CustomSelect from "./CustomSelect.vue";
import Icon from "./Icon.vue";

type Status = {
  enabled: boolean; url?: string; addresses: { address: string; name: string }[];
  address?: string; port: number; projects: string[]; approvals: boolean;
  uiMaker: boolean; terminal: boolean; browser: boolean; notes: boolean; keepAwake: boolean; passwordSet: boolean; certificateReady: boolean;
};

const status = ref<Status>();
const address = ref("");
const port = ref("8443");
const projects = ref("");
const password = ref("");
const approvals = ref(false);
const uiMaker = ref(false);
const terminal = ref(false);
const browser = ref(false);
const notes = ref(false);
const keepAwake = ref(true);
const busy = ref(false);
const message = ref("");
const error = ref("");
const addresses = computed(() => (status.value?.addresses ?? []).map(({ address, name }) => ({ value: address, label: `${name} · ${address}` })));

function apply(value: Status) {
  status.value = value;
  address.value = value.address ?? "";
  port.value = String(value.port);
  projects.value = value.projects.join("\n");
  approvals.value = value.approvals;
  uiMaker.value = value.uiMaker;
  terminal.value = value.terminal;
  browser.value = value.browser;
  notes.value = value.notes;
  keepAwake.value = value.keepAwake;
  password.value = "";
}

async function act(action: "start" | "stop" | "status") {
  if (busy.value) return;
  error.value = "";
  message.value = "";
  if (action === "start" && !/^\d{1,5}$/.test(port.value)) {
    error.value = "Enter a port from 0 to 65535.";
    return;
  }
  const sharedFolders = projects.value.split(/\r?\n/).map((folder) => folder.trim()).filter(Boolean);
  if (action === "start" && (!sharedFolders.length || ((!status.value?.passwordSet || password.value) && password.value.length < hostPasswordMinimum))) {
    error.value = sharedFolders.length ? `Use an access password of at least ${hostPasswordMinimum} characters.` : "Enter at least one shared project folder.";
    return;
  }
  busy.value = true;
  try {
    const value = await agentRequest<Status>("host-settings", action === "start" ? {
      action, address: address.value, port: Number(port.value),
      projects: sharedFolders,
      password: password.value || undefined, approvals: approvals.value, uiMaker: uiMaker.value,
      terminal: terminal.value, browser: browser.value, notes: notes.value, keepAwake: keepAwake.value,
    } : { action }, AbortSignal.timeout(65_000));
    apply(value);
    if (action === "stop") message.value = "Laptop access disconnected.";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not change Host access.";
  } finally {
    busy.value = false;
  }
}

async function copyAddress() {
  if (!status.value?.url) return;
  try {
    await navigator.clipboard.writeText(status.value.url);
    message.value = "Address copied.";
  } catch {
    message.value = "Select the address to copy it.";
  }
}

async function downloadCertificate() {
  try {
    const { certificate } = await agentRequest<{ certificate: string }>("host-settings", { action: "certificate" });
    const url = URL.createObjectURL(new Blob([certificate], { type: "application/x-x509-ca-cert" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "orvane-host-ca.crt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.value = "Trust this certificate on the laptop before signing in.";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Could not download the certificate.";
  }
}

onMounted(() => { void act("status"); });
</script>

<template>
  <section class="host-settings" aria-labelledby="host-access-heading">
    <h2 id="host-access-heading">Host access</h2>
    <form v-if="status" class="host-card" @submit.prevent="act(status.enabled ? 'stop' : 'start')">
      <div class="host-row">
        <span><strong>Host on local network</strong><small>{{ status.enabled ? "Laptop access is on" : "Off" }}</small></span>
        <button type="button" class="host-switch" role="switch" aria-label="Host on local network"
          :aria-checked="status.enabled" :disabled="busy" @click="act(status.enabled ? 'stop' : 'start')" />
      </div>
      <div v-if="status.url" class="host-row">
        <span><strong>Laptop address</strong><small>Open on the same network</small></span>
        <span class="host-actions"><code>{{ status.url }}</code><button type="button" @click="copyAddress"><Icon name="copy" :size="13" />Copy</button></span>
      </div>
      <div v-if="status.enabled && status.certificateReady" class="host-row">
        <span><strong>Laptop certificate</strong><small>Trust the public certificate on the laptop once.</small></span>
        <button type="button" @click="downloadCertificate">Download certificate</button>
      </div>
      <template v-if="!status.enabled">
        <div class="host-row">
          <label for="host-interface">Network interface</label>
          <CustomSelect id="host-interface" v-model="address" :options="addresses" aria-label="Network interface" />
        </div>
        <div class="host-row compact">
          <label for="host-port">HTTPS port</label>
          <input id="host-port" v-model="port" type="text" inputmode="numeric" maxlength="5" :disabled="busy">
        </div>
        <div class="host-row">
          <span><label for="host-password">Access password</label><small>{{ status.passwordSet ? "Leave blank to keep the current password" : `At least ${hostPasswordMinimum} characters` }}</small></span>
          <input id="host-password" v-model="password" type="password" autocomplete="new-password" :maxlength="hostPasswordMaximum" :disabled="busy">
        </div>
        <div class="host-row projects">
          <label for="host-projects">Shared project folders<small>One absolute folder path per line</small></label>
          <textarea id="host-projects" v-model="projects" rows="2" placeholder="C:\Projects\Orvane" :disabled="busy"></textarea>
        </div>
        <div class="host-row">
          <span><strong>Approval from the laptop</strong><small>Review tool arguments and answer agent questions.</small></span>
          <button type="button" class="host-switch" role="switch" aria-label="Approval from the laptop"
            :aria-checked="approvals" :disabled="busy" @click="approvals = !approvals" />
        </div>
        <div class="host-row">
          <span><strong>Share UI Maker</strong><small>Open saved versions and pick Lab variants.</small></span>
          <button type="button" class="host-switch" role="switch" aria-label="Share UI Maker"
            :aria-checked="uiMaker" :disabled="busy" @click="uiMaker = !uiMaker" />
        </div>
        <div class="host-row">
          <span><strong>Share Browser</strong><small>Open host tabs and control tabs shared from the desktop.</small></span>
          <button type="button" class="host-switch" role="switch" aria-label="Share Browser"
            :aria-checked="browser" :disabled="busy" @click="browser = !browser" />
        </div>
        <div class="host-row">
          <span><strong>Share Notes</strong><small>Open and edit the workspace’s Notes pages from the laptop.</small></span>
          <button type="button" class="host-switch" role="switch" aria-label="Share Notes"
            :aria-checked="notes" :disabled="busy" @click="notes = !notes" />
        </div>
        <div class="host-row">
          <span><strong>Share open terminals</strong><small>Allow full shell input in terminals opened in a shared project.</small></span>
          <button type="button" class="host-switch" role="switch" aria-label="Share open terminals"
            :aria-checked="terminal" :disabled="busy" @click="terminal = !terminal" />
        </div>
        <div class="host-row">
          <span><strong>Keep awake while hosting</strong><small>The display can still turn off.</small></span>
          <button type="button" class="host-switch" role="switch" aria-label="Keep awake while hosting"
            :aria-checked="keepAwake" :disabled="busy" @click="keepAwake = !keepAwake" />
        </div>
      </template>
    </form>
    <p v-if="busy" role="status">Updating Host access…</p>
    <p v-else-if="message" role="status">{{ message }}</p>
    <p v-if="error" class="host-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
/* Same card, row, button and switch values as AgentSettings.vue around it. */
.host-settings { max-width: 760px; margin-bottom: 26px; }
h2 { color: #7a8f9b; font-size: 10.5px; font-weight: 600; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; }
p { margin: 10px 2px 0; color: #8296a2; font-size: 12px; }
.host-card { overflow: hidden; border: 1px solid #dbe5ea; border-radius: 10px; background: #f2f6f8; }
.host-row { min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 14px; }
.host-row + .host-row { border-top: 1px solid #e3eaee; }
.host-row small { display: block; color: #8296a2; font-size: 12px; font-weight: 400; }
.host-row strong, label { font-weight: 550; color: #273f50; }
.host-row :is(input, textarea) { font: inherit; font-size: 12.5px; color: #273f50; min-width: 0; width: min(60%, 325px); border: 1px solid #d5e0e5; border-radius: 7px; padding: 0 9px; background: #fbfcfd; outline: 0; }
.host-row input { height: 28px; }
.host-row textarea { padding: 6px 9px; resize: vertical; font-family: "Cascadia Code", Consolas, monospace; font-size: 11.5px; }
.host-row :is(input, textarea):focus { border-color: #7b97a7; }
.host-row :is(input, textarea)::placeholder { color: #8296a2; }
.host-row.compact input { width: 65px; text-align: right; }
.host-row :deep(.select-trigger) { max-width: 290px; }
.host-row button:not(.host-switch) { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; font: inherit; font-size: 12px; color: #455968; padding: 0 10px; border: 1px solid #d3dee5; border-radius: 7px; background: #fbfcfd; cursor: pointer; white-space: nowrap; }
.host-row button:not(.host-switch):hover { background: #eef3f6; }
.host-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; }
.host-actions code { overflow-wrap: anywhere; color: #385d76; font: 11.5px "Cascadia Code", Consolas, monospace; }
.host-switch { position: relative; width: 30px; height: 18px; flex: none; padding: 0; border: 0; border-radius: 9px; background: #c9d6de; cursor: pointer; transition: background .15s; }
.host-switch::after { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #263f5533; content: ""; transition: transform .15s; }
.host-switch[aria-checked="true"] { background: #365f78; }
.host-switch[aria-checked="true"]::after { transform: translateX(12px); }
.host-switch:disabled { opacity: .55; cursor: default; }
.host-row button:focus-visible, .host-switch:focus-visible { outline: none; box-shadow: 0 0 0 3px #6f899840; }
.host-error { color: #a0624f; }
@media (prefers-reduced-motion: reduce) { .host-switch, .host-switch::after { transition: none; } }
</style>
