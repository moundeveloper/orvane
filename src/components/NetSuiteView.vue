<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from "vue";
import CustomSelect from "./CustomSelect.vue";
import NetSuiteDashboard from "./NetSuiteDashboard.vue";
import NetSuiteHome from "./NetSuiteHome.vue";
import NetSuiteFileCabinet from "./NetSuiteFileCabinet.vue";
import NetSuiteScripts from "./NetSuiteScripts.vue";
import NetSuiteQuery, { type QueryFile } from "./NetSuiteQuery.vue";
import Icon from "./Icon.vue";
import SplitTabs from "./SplitTabs.vue";
import {
  addTab,
  closeTab,
  groupOf,
  reopenTab,
  restoreLayout,
  splitLayout,
  type SplitLayout,
  type SplitSide,
} from "../splitTabs";
import type { Block } from "../model";
import { uid } from "../model";

const props = defineProps<{ block: Block }>();
type Tab = { id: string; label: string; status: string; count: number };
type Row = Record<string, unknown>;
type AppId = "scripts" | "files" | "query";
type TrailItem = { app: AppId; environment: string; visitedAt: number };
type ViewKind = "home" | "dashboard" | AppId;
type ViewTab = {
  id: string;
  view: ViewKind;
  dashboard: string;
  version: number;
  file?: { id: number; name: string };
};
const validApp = (value: unknown): value is AppId =>
  value === "scripts" || value === "files" || value === "query";
function navigationState() {
  try {
    const state = JSON.parse(props.block.value);
    return {
      preferred: Array.isArray(state.preferredApps)
        ? (state.preferredApps.filter(validApp) as AppId[])
        : [],
      trail: Array.isArray(state.appTrail)
        ? (state.appTrail.filter(
            (item: TrailItem) =>
              item &&
              validApp(item.app) &&
              typeof item.environment === "string" &&
              Number.isFinite(item.visitedAt),
          ) as TrailItem[])
        : [],
    };
  } catch {
    return { preferred: [] as AppId[], trail: [] as TrailItem[] };
  }
}
const initialNavigation = navigationState();
const preferred = ref<AppId[]>(initialNavigation.preferred),
  trail = ref<TrailItem[]>(initialNavigation.trail);
watch(
  [preferred, trail],
  () => {
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(props.block.value) || {};
    } catch {
      /* New workspace. */
    }
    props.block.value = JSON.stringify({
      ...state,
      preferredApps: preferred.value,
      appTrail: trail.value,
    });
  },
  { deep: true },
);
const appMenuOpen = ref(false),
  appMenu = ref<HTMLElement>();
// Workspace tabs, like Magic NetSuite's ViewTabsWorkspace: every tab keeps its
// own view instance, navigation acts on the focused tab, and tabs can split.
const VIEW_LABELS: Record<ViewKind, [string, string]> = {
  home: ["Home", "app"],
  dashboard: ["Dashboards", "layers"],
  scripts: ["Scripts", "code"],
  files: ["File Cabinet", "folder"],
  query: ["SuiteQL", "search"],
};
const viewKind = (value: unknown): value is ViewKind =>
  value === "home" || value === "dashboard" || validApp(value);
function initialWorkspace() {
  try {
    const saved = JSON.parse(props.block.value)?.viewTabs;
    const list: ViewTab[] = (Array.isArray(saved?.tabs) ? saved.tabs : [])
      .filter((t: ViewTab) => t && typeof t.id === "string" && viewKind(t.view))
      .slice(0, 30)
      .map((t: ViewTab) => ({
        id: t.id,
        view: t.view,
        dashboard: typeof t.dashboard === "string" ? t.dashboard : "",
        version: 0,
      }));
    const ids = list.map((t) => t.id),
      layout = restoreLayout({ ...saved?.layout, tabs: ids }, ids);
    if (list.length && layout) return { list, layout };
  } catch {
    /* New workspace. */
  }
  return {
    list: [{ id: "main", view: "home" as ViewKind, dashboard: "", version: 0 }],
    layout: splitLayout(["main"]),
  };
}
const workspace = initialWorkspace();
const viewTabs = ref<ViewTab[]>(workspace.list),
  tabLayout = ref<SplitLayout>(workspace.layout),
  closedViews = ref<
    { tab: ViewTab; closed: { id: string; group: SplitSide | null; index: number } }[]
  >([]);
const focusedTab = computed(
  () =>
    viewTabs.value.find((t) => t.id === tabLayout.value.active) ??
    viewTabs.value[0]!,
);
const view = computed(() => focusedTab.value.view);
function tabOf(id: string) {
  return viewTabs.value.find((t) => t.id === id) ?? focusedTab.value;
}
function tabInfo(id: string) {
  const [label, icon] = VIEW_LABELS[tabOf(id).view];
  return { label, icon };
}
function navigate(next: ViewKind, dashboard = "") {
  const tab = focusedTab.value;
  tab.view = next;
  tab.dashboard = dashboard;
  appMenuOpen.value = false;
}
function newViewTab(group: SplitSide | null = null, from?: ViewTab) {
  const tab: ViewTab = {
    id: uid(),
    view: from?.view ?? "home",
    dashboard: from?.dashboard ?? "",
    version: 0,
  };
  viewTabs.value.push(tab);
  addTab(tabLayout.value, tab.id, group ?? (from ? groupOf(tabLayout.value, from.id) : null), from?.id);
}
function closeViewTab(id: string) {
  const closed = closeTab(tabLayout.value, id);
  if (!closed) return;
  const index = viewTabs.value.findIndex((t) => t.id === id),
    [tab] = viewTabs.value.splice(index, 1);
  if (tab) closedViews.value = [...closedViews.value, { tab, closed }].slice(-10);
}
function reopenViewTab() {
  const restored = closedViews.value.pop();
  if (!restored) return;
  viewTabs.value.push(restored.tab);
  reopenTab(tabLayout.value, restored.closed);
}
watch(
  [viewTabs, tabLayout],
  () => {
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(props.block.value) || {};
    } catch {
      /* New workspace. */
    }
    props.block.value = JSON.stringify({
      ...state,
      viewTabs: {
        tabs: viewTabs.value.map(({ id, view, dashboard }) => ({
          id,
          view,
          dashboard,
        })),
        layout: tabLayout.value,
      },
    });
  },
  { deep: true },
);
const pinnedDashboards = computed(() => {
  try {
    const data = JSON.parse(props.block.value);
    return Array.isArray(data.dashboards)
      ? data.dashboards
          .filter(
            (d: any) =>
              d &&
              d.pinned &&
              typeof d.id === "string" &&
              typeof d.title === "string",
          )
          .map((d: any) => ({ id: d.id, title: d.title }))
      : [];
  } catch {
    return [];
  }
});
function unpinDashboard(id: string) {
  try {
    const data = JSON.parse(props.block.value);
    if (!Array.isArray(data.dashboards)) return;
    data.dashboards = data.dashboards.map((d: any) =>
      d.id === id ? { ...d, pinned: false } : d,
    );
    props.block.value = JSON.stringify(data);
  } catch {
    /* No saved dashboard. */
  }
}
function openDashboard(id: string) {
  navigate("dashboard", id);
}
function togglePreferred(id: AppId) {
  preferred.value = preferred.value.includes(id)
    ? preferred.value.filter((x) => x !== id)
    : [...preferred.value, id];
}
function openApp(id: AppId) {
  navigate(id);
  if (selected.value)
    trail.value = [
      { app: id, environment: selected.value, visitedAt: Date.now() },
      ...trail.value.filter(
        (item) => item.app !== id || item.environment !== selected.value,
      ),
    ].slice(0, 30);
}
function removeRecent(id: AppId) {
  trail.value = trail.value.filter(
    (item) => item.app !== id || item.environment !== selected.value,
  );
}
function clearRecent() {
  trail.value = trail.value.filter(
    (item) => item.environment !== selected.value,
  );
}
function dismissAppMenu(event: PointerEvent) {
  if (!appMenu.value?.contains(event.target as Node)) appMenuOpen.value = false;
}
function escapeAppMenu(event: KeyboardEvent) {
  if (event.key === "Escape") appMenuOpen.value = false;
}
const api = (
  window as unknown as {
    orvaneDesktop?: {
      netsuite?: {
        tabs(): Promise<Tab[]>;
        openRecord?(origin: string, kind: string, id: number): Promise<void>;
        run(
          id: string,
          operation: string,
          args?: Record<string, unknown>,
        ): Promise<Row>;
      };
    };
  }
).orvaneDesktop?.netsuite;
function initialFiles(): QueryFile[] {
  try {
    const data = JSON.parse(props.block.value);
    if (Array.isArray(data.queries)) {
      const files = data.queries.filter(
        (q: QueryFile) =>
          q &&
          typeof q.id === "string" &&
          typeof q.name === "string" &&
          typeof q.sql === "string",
      );
      if (files.length) return files;
    }
  } catch {
    /* Start with an example query. */
  }
  return [
    {
      id: uid(),
      name: "Untitled query",
      sql: "SELECT id, entityid FROM customer WHERE ROWNUM <= 20",
    },
  ];
}
const files = ref(initialFiles());
watch(
  files,
  () => {
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(props.block.value) || {};
    } catch {
      /* New workspace. */
    }
    props.block.value = JSON.stringify({ ...state, queries: files.value });
  },
  { deep: true },
);
const tabs = ref<Tab[]>([]),
  selected = ref("");
const busy = ref(false),
  error = ref(""),
  userInfo = ref<Row | null>(null);
const selectedStatus = computed(
  () => tabs.value.find((t) => t.id === selected.value)?.status,
);
let generation = 0,
  refreshSequence = 0;
const options = computed(() => [
  {
    value: "",
    label: tabs.value.length
      ? "Choose an environment"
      : "No NetSuite environments",
  },
  ...tabs.value.map((t) => ({ value: t.id, label: t.label })),
]);
async function refreshTabs() {
  if (!api) return;
  const request = ++refreshSequence;
  try {
    const found = await api.tabs();
    if (request !== refreshSequence) return;
    tabs.value = found;
    if (!tabs.value.some((t) => String(t.id) === selected.value))
      selected.value = tabs.value.length === 1 ? String(tabs.value[0]!.id) : "";
  } catch (e) {
    if (request === refreshSequence) error.value = message(e);
  }
}
const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    "",
  );
async function call(
  operation: string,
  args: Record<string, unknown> = {},
): Promise<Row | undefined> {
  if (!api || !selected.value || busy.value) return;
  const request = generation;
  busy.value = true;
  error.value = "";
  try {
    const data = await api.run(selected.value, operation, args);
    return request === generation ? data : undefined;
  } catch (e) {
    if (request === generation) error.value = message(e);
  } finally {
    busy.value = false;
  }
}
async function loadUser() {
  const data = await call("user");
  if (data) userInfo.value = data;
}
async function openRecord(kind: string, id: unknown) {
  try {
    if (!api?.openRecord)
      throw Error("Opening records requires Orvane Desktop.");
    await api.openRecord(selected.value, kind, Number(id));
  } catch (e) {
    error.value = message(e);
  }
}
function editScriptFile(file: { id: number; name: string }) {
  focusedTab.value.file = file;
  openApp("files");
}
async function fileRequest(operation: string, args: Row = {}): Promise<Row> {
  if (!api || !selected.value) throw Error("Choose an environment.");
  try {
    return await api.run(selected.value, operation, args);
  } catch (e) {
    throw Error(message(e));
  }
}
async function runDashboardQuery(sql: string): Promise<Row> {
  if (!api || !selected.value) throw Error("Choose an environment.");
  return api.run(selected.value, "query", { sql, offset: 0 });
}
watch(selected, () => {
  generation++;
  error.value = "";
  userInfo.value = null;
});
let stopProcessing: (() => void) | undefined;
onMounted(() => {
  void refreshTabs();
  stopProcessing = (window as any).orvaneDesktop?.processing?.onChanged(() => {
    void refreshTabs();
  });
  document.addEventListener("pointerdown", dismissAppMenu, true);
  document.addEventListener("keydown", escapeAppMenu);
});
onBeforeUnmount(() => {
  stopProcessing?.();
  document.removeEventListener("pointerdown", dismissAppMenu, true);
  document.removeEventListener("keydown", escapeAppMenu);
});
</script>
<template>
  <div class="ns-workspace">
    <div class="ns-connection">
      <strong>NetSuite</strong
      ><CustomSelect
        v-model="selected"
        :options="options"
        aria-label="NetSuite environment"
      /><button
        v-if="selected"
        class="subtle-button"
        :disabled="busy"
        @click="loadUser"
      >
        Current user
      </button>
    </div>
    <p v-if="userInfo" class="ns-account">
      {{ userInfo.name }} · {{ userInfo.account }} · Role {{ userInfo.role }}
    </p>
    <nav class="ns-nav" aria-label="NetSuite navigation">
      <button
        :class="{ active: view === 'home' }"
        @click="navigate('home')"
      >
        Home
      </button>
      <div ref="appMenu" class="ns-menu-anchor">
        <button
          :class="{ active: appMenuOpen }"
          aria-label="Apps menu"
          :aria-expanded="appMenuOpen"
          @click="appMenuOpen = !appMenuOpen"
        >
          <Icon name="app" :size="14" /> Apps
        </button>
        <div
          v-if="appMenuOpen"
          class="ns-app-menu"
          role="region"
          aria-label="Apps menu"
        >
          <div class="ns-menu-heading">
            <strong>Navigation Items</strong
            ><button aria-label="Close apps menu" @click="appMenuOpen = false">
              <Icon name="close" :size="14" />
            </button>
          </div>
          <NetSuiteHome
            compact
            :preferred="preferred"
            :trail="trail"
            :environment="selected"
            @open="openApp"
            @toggle="togglePreferred"
          />
        </div>
      </div>
      <button
        :class="{ active: view === 'dashboard' }"
        @click="navigate('dashboard')"
      >
        Dashboards
      </button>
    </nav>
    <p v-if="error" class="ns-error" role="alert">{{ error }}</p>
    <SplitTabs
      class="ns-tabs"
      :layout="tabLayout"
      :info="tabInfo"
      label="NetSuite"
      :can-reopen="closedViews.length > 0"
      @add="newViewTab($event)"
      @close="closeViewTab"
      @reopen="reopenViewTab"
      @reload="tabOf($event).version++"
      @duplicate="newViewTab(null, tabOf($event))"
    >
      <template #pane="{ id }"
        ><template v-for="tab in [tabOf(id)]" :key="`${tab.id}:${tab.version}`">
          <NetSuiteHome
            v-if="tab.view === 'home'"
            :preferred="preferred"
            :trail="trail"
            :pinned="pinnedDashboards"
            :environment="selected"
            @open="openApp"
            @toggle="togglePreferred"
            @remove-recent="removeRecent"
            @clear-recent="clearRecent"
            @open-dashboard="openDashboard"
            @unpin-dashboard="unpinDashboard"
          />
          <p v-else-if="!api" class="ns-notice">
            Open Orvane Desktop to connect to a NetSuite browser tab.
          </p>
          <p v-else-if="!selected" class="ns-notice">
            Sign in to NetSuite in Browser and choose your environment.
          </p>
          <KeepAlive
            v-else
            :include="['NetSuiteScripts', 'NetSuiteQuery']"
          >
            <NetSuiteDashboard
              v-if="tab.view === 'dashboard'"
              :key="`dashboard:${tab.dashboard}`"
              :block="block"
              :run-query="runDashboardQuery"
              :environment="selected"
              :initial-id="tab.dashboard"
            />
            <NetSuiteFileCabinet
              v-else-if="tab.view === 'files'"
              :block="block"
              :environment="selected"
              :request="fileRequest"
              :open-record="openRecord"
              :initial-file="tab.file"
              :storage-key="tab.id === 'main' ? '' : tab.id"
              @opened-initial="tab.file = undefined"
            />
            <NetSuiteScripts
              v-else-if="tab.view === 'scripts'"
              :block="block"
              :environment="selected"
              :request="fileRequest"
              :open-record="openRecord"
              :status="selectedStatus"
              @edit-file="editScriptFile"
            />
            <NetSuiteQuery
              v-else-if="tab.view === 'query'"
              :block="block"
              :environment="selected"
              :request="fileRequest"
              :open-record="openRecord"
              :files="files"
              :state-key="tab.id"
            />
          </KeepAlive> </template
      ></template>
    </SplitTabs>
  </div>
</template>
<style>
.app-content:has(> .block-netsuite:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-netsuite {
  flex: 1;
  min-height: 260px;
}
.block-netsuite:not(:only-child) {
  height: 520px;
}
</style>
<style scoped>
.ns-workspace {
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: #455968;
  font-size: 12px;
  background: #f7f9fa;
  overflow: hidden;
}
.ns-connection {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid #dce5e9;
}
.ns-connection strong {
  font-size: 14px;
}
.ns-connection :deep(.custom-select) {
  min-width: 220px;
}
.ns-nav {
  position: relative;
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 0 16px;
  border-bottom: 1px solid #dce5e9;
}
.ns-nav button {
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  padding: 12px 2px;
  color: #657b89;
  cursor: pointer;
}
.ns-nav button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ns-tabs {
  flex: 1;
  min-height: 0;
}
.ns-menu-anchor {
  position: static;
}
.ns-app-menu {
  position: absolute;
  z-index: 30;
  top: 100%;
  left: 16px;
  width: min(520px, calc(100% - 32px));
  max-height: min(560px, 70vh);
  display: flex;
  flex-direction: column;
  background: #f7f9fa;
  border: 1px solid #d8e3e8;
  box-shadow: 0 8px 22px #405b6b26;
}
.ns-menu-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid #dce5e9;
}
.ns-menu-heading button {
  padding: 4px;
  border: 0;
}
.ns-nav button.active {
  border-color: #668698;
  color: #344d5b;
  font-weight: 600;
}
.ns-notice {
  color: #627783;
  margin: 18px;
}
.ns-error {
  color: #9b3835;
  margin: 10px 16px;
  white-space: pre-wrap;
}
.ns-file-row:hover {
  background: #eaf1f4;
}
.ns-breadcrumb {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0 16px 12px;
  overflow: auto;
  white-space: nowrap;
}
.ns-breadcrumb button {
  border: 0;
  background: none;
  color: #547589;
  cursor: pointer;
}
.ns-files {
  display: flex;
  flex: 1;
  min-height: 0;
  border-top: 1px solid #dce5e9;
}
.ns-file-list {
  flex: 1;
  min-width: 180px;
  overflow: auto;
}
.ns-file-row {
  width: 100%;
  display: flex;
  gap: 12px;
  text-align: left;
  align-items: center;
  padding: 11px 16px;
  border: 0;
  border-bottom: 1px solid #e4ebee;
  background: none;
  color: inherit;
  cursor: pointer;
}
.ns-file-row small {
  margin-left: auto;
  color: #657b89;
}
.ns-file-kind {
  color: #718894;
  font-size: 11px;
  min-width: 38px;
}
.ns-preview {
  width: 55%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid #dce5e9;
}
.ns-preview-title {
  padding: 12px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.ns-preview pre {
  margin: 0;
  padding: 12px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #edf3f6;
  flex: 1;
}
.ns-account {
  margin: 0;
  padding: 7px 16px;
  background: #edf3f6;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 650px) {
  .ns-connection {
    flex-wrap: wrap;
  }
  .ns-preview {
    width: 50%;
  }
}
</style>
