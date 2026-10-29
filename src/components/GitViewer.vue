<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import type { Block } from "../model";
import {
  gitRequest,
  gitLanes,
  type GitWorkspace,
  type GitHistory,
  type GitCommitDetail,
  type GitStatus,
  type GitFolder,
} from "../git";
import Icon from "./Icon.vue";
import CustomSelect from "./CustomSelect.vue";
import { vMotion } from "../motion";
import "../git.css";
const props = defineProps<{ block: Block; editing: boolean }>();
const tooltip = ref<{
  text: string;
  left: number;
  top: number;
  width: number;
}>();
const tooltipElement = ref<HTMLElement>();
const tooltipId = `git-tooltip-${crypto.randomUUID()}`;
let tooltipTarget: HTMLElement | undefined;
let tooltipTimer: ReturnType<typeof setTimeout> | undefined;
let tooltipPointer: { x: number; y: number } | undefined;
function positionTooltip() {
  if (!tooltip.value || !tooltipTarget) return;
  const bounds = tooltipTarget.getBoundingClientRect();
  const point = tooltipPointer || { x: bounds.right, y: bounds.top };
  const gap = 16,
    margin = 12;
  const rightSpace = innerWidth - point.x - gap - margin;
  const leftSpace = point.x - gap - margin;
  const right = rightSpace >= 420 || rightSpace >= leftSpace;
  const width = Math.min(
    420,
    innerWidth - margin * 2,
    Math.max(80, right ? rightSpace : leftSpace),
  );
  tooltip.value.width = width;
  tooltip.value.left = Math.max(
    margin,
    Math.min(
      right ? point.x + gap : point.x - gap - width,
      innerWidth - width - margin,
    ),
  );
  const height = tooltipElement.value?.getBoundingClientRect().height || 0;
  tooltip.value.top = Math.max(
    margin,
    Math.min(point.y - 16, innerHeight - height - margin),
  );
}
function moveTooltip(event: PointerEvent | WheelEvent) {
  tooltipPointer = { x: event.clientX, y: event.clientY };
  positionTooltip();
}
function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTarget?.removeAttribute("aria-describedby");
  tooltipTarget = undefined;
  tooltip.value = undefined;
}
function showTooltip(event: PointerEvent | FocusEvent) {
  tooltipPointer =
    event instanceof PointerEvent
      ? { x: event.clientX, y: event.clientY }
      : undefined;
  const target = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-git-tooltip]",
  );
  if (target === tooltipTarget) return;
  hideTooltip();
  if (!target?.dataset.gitTooltip) return;
  tooltipTarget = target;
  tooltipTimer = setTimeout(
    async () => {
      if (!target.isConnected) return hideTooltip();
      tooltip.value = {
        text: target.dataset.gitTooltip!,
        left: 12,
        top: 12,
        width: 420,
      };
      positionTooltip();
      target.setAttribute("aria-describedby", tooltipId);
      await nextTick();
      positionTooltip();
    },
    event.type === "focusin" ? 0 : 350,
  );
}
function leaveTooltip(event: PointerEvent) {
  if (
    tooltipTarget &&
    event.relatedTarget instanceof Node &&
    tooltipTarget.contains(event.relatedTarget)
  )
    return;
  hideTooltip();
}
const workspaces = ref<GitWorkspace[]>([]),
  history = ref<GitHistory>(),
  status = ref<GitStatus>();
const busy = ref(false),
  error = ref(""),
  branch = ref(""),
  query = ref(""),
  tab = ref<"history" | "changes">("history");
const detail = ref<GitCommitDetail>(),
  selectedHash = ref(""),
  selectedFile = ref(""),
  patch = ref(""),
  truncated = ref(false),
  detailBusy = ref(false);
const changeMode = ref<"worktree" | "index">("worktree");
const order = ref<"date" | "topo">("date");
const mainElement = ref<HTMLElement>();
const historyShare = ref(0.53);
let splitPointer: number | undefined;
function resizeDetails(event: PointerEvent) {
  if (splitPointer !== event.pointerId) return;
  const bounds = mainElement.value?.getBoundingClientRect();
  if (!bounds?.height) return;
  historyShare.value = Math.min(
    0.82,
    Math.max(0.18, (event.clientY - bounds.top) / bounds.height),
  );
}
function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  splitPointer = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function resizeKeys(event: KeyboardEvent) {
  const delta =
    event.key === "ArrowUp" ? -0.04 : event.key === "ArrowDown" ? 0.04 : 0;
  if (!delta && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  historyShare.value =
    event.key === "Home"
      ? 0.18
      : event.key === "End"
        ? 0.82
        : Math.min(0.82, Math.max(0.18, historyShare.value + delta));
}
function viewerWheel(event: WheelEvent) {
  moveTooltip(event);
  if (!(event.ctrlKey || event.metaKey)) event.stopPropagation();
}
const current = computed(() =>
  workspaces.value.find((w) => w.id === props.block.gitWorkspaceId),
);
const rows = computed(() =>
  gitLanes(
    history.value?.commits || [],
    new Set(history.value?.mainline || []),
  ),
);
const graphWidth = computed(() =>
  Math.max(60, ...rows.value.map((r) => Math.max(r.before, r.after) * 14 + 18)),
);
const colors = [
  "#527b96",
  "#88709e",
  "#468577",
  "#b07c3f",
  "#9a6574",
  "#677f4b",
];
const filteredMatches = computed(
  () =>
    history.value?.commits.filter((c) =>
      `${c.subject} ${c.author} ${c.hash}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
    ) || [],
);
const patchLines = computed(() => patch.value.split("\n"));
const pathInput = ref(""),
  workspaceName = ref(""),
  folder = ref<GitFolder>(),
  picker = ref(false),
  folderBusy = ref(false),
  folderError = ref("");
const pickerElement = ref<HTMLElement>(),
  folderInput = ref<HTMLInputElement>();
let folderRequest = 0;
let request = 0,
  detailsRequest = 0,
  patchRequest = 0;
const controllers = new Set<AbortController>();
async function api<T>(operation: string, args: object = {}) {
  const controller = new AbortController();
  controllers.add(controller);
  try {
    return await gitRequest<T>(operation, args, controller.signal);
  } finally {
    controllers.delete(controller);
  }
}
onBeforeUnmount(() => {
  hideTooltip();
  request++;
  detailsRequest++;
  patchRequest++;
  controllers.forEach((c) => c.abort());
});
async function refreshWorkspaces() {
  workspaces.value = await api<GitWorkspace[]>("git_workspace_list");
}
function clearDetails() {
  detailsRequest++;
  patchRequest++;
  detail.value = undefined;
  selectedHash.value = "";
  selectedFile.value = "";
  patch.value = "";
  detailBusy.value = false;
}
async function load(append = false) {
  if (!props.block.gitWorkspaceId) return;
  const sequence = ++request;
  busy.value = true;
  error.value = "";
  try {
    const [log, changes] = await Promise.all([
      api<GitHistory>("git_history", {
        workspaceId: props.block.gitWorkspaceId,
        ...(branch.value ? { ref: branch.value } : {}),
        offset: append ? history.value?.commits.length || 0 : 0,
        limit: 150,
        order: order.value,
      }),
      api<GitStatus>("git_status", { workspaceId: props.block.gitWorkspaceId }),
    ]);
    if (sequence !== request) return;
    if (append && history.value) {
      const existing = new Set(history.value.commits.map((c) => c.hash));
      log.commits = [
        ...history.value.commits,
        ...log.commits.filter((c) => !existing.has(c.hash)),
      ];
    }
    history.value = log;
    status.value = changes;
  } catch (e) {
    if (sequence === request)
      error.value =
        e instanceof Error ? e.message : "The repository could not be read.";
  } finally {
    if (sequence === request) busy.value = false;
  }
}
watch(
  () => props.block.gitWorkspaceId,
  () => {
    branch.value = "";
    query.value = "";
    history.value = undefined;
    status.value = undefined;
    clearDetails();
    void initialize();
  },
);
watch(branch, () => {
  clearDetails();
  void load();
});
async function initialize() {
  try {
    await refreshWorkspaces();
    await load();
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : "Git workspaces could not be loaded.";
  }
}
void initialize();
async function selectCommit(hash: string) {
  const sequence = ++detailsRequest;
  patchRequest++;
  selectedHash.value = hash;
  selectedFile.value = "";
  detail.value = undefined;
  patch.value = "";
  detailBusy.value = true;
  error.value = "";
  try {
    const result = await api<GitCommitDetail>("git_commit", {
      workspaceId: props.block.gitWorkspaceId,
      hash,
    });
    if (sequence !== detailsRequest) return;
    detail.value = result;
    if (result.files[0]) await selectFile(result.files[0].path);
  } catch (e) {
    if (sequence === detailsRequest)
      error.value =
        e instanceof Error ? e.message : "The commit could not be opened.";
  } finally {
    if (sequence === detailsRequest) detailBusy.value = false;
  }
}
async function selectFile(
  path: string,
  mode: "worktree" | "index" = changeMode.value,
) {
  const sequence = ++patchRequest;
  selectedFile.value = path;
  changeMode.value = mode;
  patch.value = "";
  truncated.value = false;
  try {
    const result = await api<{ patch: string; truncated: boolean }>(
      "git_diff",
      {
        workspaceId: props.block.gitWorkspaceId,
        file: path,
        ...(selectedHash.value ? { hash: selectedHash.value } : { mode }),
      },
    );
    if (sequence !== patchRequest) return;
    patch.value = result.patch;
    truncated.value = result.truncated;
  } catch (e) {
    if (sequence === patchRequest)
      error.value =
        e instanceof Error ? e.message : "The diff could not be loaded.";
  }
}
function selectChange(path: string, index: string) {
  clearDetails();
  tab.value = "changes";
  void selectFile(path, index !== " " && index !== "?" ? "index" : "worktree");
}
function changeTab(value: "history" | "changes") {
  tab.value = value;
  clearDetails();
}
async function browse(path?: string) {
  const sequence = ++folderRequest,
    previousInput = pathInput.value;
  folderBusy.value = true;
  folderError.value = "";
  try {
    const result = await api<GitFolder>("git_folders", path ? { path } : {});
    if (sequence !== folderRequest) return;
    folder.value = result;
    if (pathInput.value === previousInput) pathInput.value = result.path;
  } catch (e) {
    if (sequence === folderRequest)
      folderError.value =
        e instanceof Error ? e.message : "This folder could not be opened.";
  } finally {
    if (sequence === folderRequest) folderBusy.value = false;
  }
}
async function openPicker() {
  picker.value = true;
  workspaceName.value = "";
  await nextTick();
  folderInput.value?.focus();
  await browse(current.value?.path);
}
async function saveFolder() {
  if (!pathInput.value.trim() || folderBusy.value) return;
  folderBusy.value = true;
  folderError.value = "";
  try {
    const saved = await api<GitWorkspace>("git_workspace_add", {
      path: pathInput.value.trim(),
      ...(workspaceName.value.trim()
        ? { name: workspaceName.value.trim() }
        : {}),
    });
    await refreshWorkspaces();
    picker.value = false;
    props.block.gitWorkspaceId = saved.id;
  } catch (e) {
    folderError.value =
      e instanceof Error
        ? e.message
        : "Choose a folder containing a Git repository.";
  } finally {
    folderBusy.value = false;
  }
}
function pickerKeys(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.stopPropagation();
    picker.value = false;
    return;
  }
  if (event.key !== "Tab") return;
  const controls = [
    ...(pickerElement.value?.querySelectorAll<HTMLElement>(
      "button:not(:disabled),input:not(:disabled)",
    ) || []),
  ];
  if (event.shiftKey && document.activeElement === controls[0]) {
    event.preventDefault();
    controls.at(-1)?.focus();
  } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
    event.preventDefault();
    controls[0]?.focus();
  }
}
function nextMatch() {
  const matches = filteredMatches.value;
  if (!matches.length) return;
  const at = matches.findIndex((c) => c.hash === selectedHash.value);
  const commit = matches[(at + 1) % matches.length]!;
  void selectCommit(commit.hash);
  nextTick(() =>
    document
      .querySelector(`[data-git-commit="${commit.hash}"]`)
      ?.scrollIntoView({ block: "nearest" }),
  );
}
function date(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
function curve(from: number, to: number, top = 0, bottom = 36) {
  const a = 12 + from * 14,
    b = 12 + to * 14;
  return `M ${a} ${top} C ${a} ${(top + bottom) / 2} ${b} ${(top + bottom) / 2} ${b} ${bottom}`;
}
</script>
<template>
  <div
    class="git-viewer"
    aria-label="Local Git viewer"
    @wheel="viewerWheel"
    @keydown.stop
    @keydown.esc="hideTooltip"
    @pointerover="showTooltip"
    @pointermove="moveTooltip"
    @pointerout="leaveTooltip"
    @focusin="showTooltip"
    @focusout="hideTooltip"
    @scroll.capture="hideTooltip"
    @pointerdown="hideTooltip"
  >
    <div class="git-toolbar">
      <Icon name="git" :size="17" />
      <CustomSelect
        v-model="block.gitWorkspaceId"
        aria-label="Git workspace"
        :options="workspaces.map((w) => ({ value: w.id, label: w.name }))"
        placeholder="Choose a Git workspace"
      />
      <button class="subtle-button" @click="openPicker">
        <Icon name="folder" :size="14" />Add folder
      </button>
      <button
        class="icon-button"
        aria-label="Refresh Git history"
        :disabled="busy || !current"
        @click="initialize"
      >
        <Icon name="refresh" :size="14" />
      </button>
    </div>
    <div v-if="current" class="git-location" :data-git-tooltip="current.path">
      <span>{{ current.path }}</span
      ><span v-if="history?.mainBranch" class="git-main-legend"
        ><i />{{ history.mainBranch }} · main branch</span
      ><span v-if="history"
        ><Icon name="git" :size="12" />{{ history.branch }}</span
      >
    </div>
    <div v-if="error" class="git-error" role="alert">
      <span>{{ error }}</span
      ><button class="subtle-button" @click="initialize">Retry</button>
    </div>
    <div v-if="!current && !busy" class="git-empty">
      <Icon name="git" :size="32" />
      <h2>Your repositories, in view.</h2>
      <p>
        Choose a local folder to explore its branches,<br />commit history and
        changes.
      </p>
      <button class="subtle-button" @click="openPicker">
        <Icon name="folder-open" :size="14" />Choose a folder
      </button>
    </div>
    <template v-else-if="current">
      <div class="git-filters">
        <div class="git-tabs">
          <button
            :class="{ active: tab === 'history' }"
            @click="changeTab('history')"
          >
            History</button
          ><button
            :class="{ active: tab === 'changes' }"
            @click="changeTab('changes')"
          >
            Changes <span>{{ status?.files.length || 0 }}</span>
          </button>
        </div>
        <CustomSelect
          v-if="tab === 'history'"
          v-model="branch"
          aria-label="Git branch filter"
          :options="[
            { value: '', label: 'All branches' },
            ...(history?.refs || []).map((r) => ({
              value: r.fullName,
              label: r.name,
            })),
          ]"
        />
        <input
          v-if="tab === 'history'"
          v-model="query"
          class="git-search"
          aria-label="Search commits"
          placeholder="Find a commit…"
          @keydown.enter="nextMatch"
        />
        <CustomSelect
          v-if="tab === 'history'"
          v-model="order"
          aria-label="Git history order"
          :options="[
            { value: 'date', label: 'Date order' },
            { value: 'topo', label: 'Branch topology' },
          ]"
          @change="
            clearDetails();
            load();
          "
        />
        <button
          v-if="query && tab === 'history'"
          class="subtle-button"
          @click="nextMatch"
        >
          {{ filteredMatches.length }} matches
        </button>
      </div>
      <div
        ref="mainElement"
        class="git-main"
        :class="{ 'has-detail': selectedHash || selectedFile }"
        :style="{
          '--git-history-share': `${historyShare}fr`,
          '--git-detail-share': `${1 - historyShare}fr`,
        }"
      >
        <div v-if="tab === 'history'" class="git-history" :aria-busy="busy">
          <div
            class="git-history-heading"
            :style="{ '--git-graph-width': `${graphWidth}px` }"
          >
            <span>Graph</span><span>Commit</span><span>Author</span
            ><span>Date</span><span>Hash</span>
          </div>
          <div class="git-history-rows">
            <button
              v-for="(commit, index) in history?.commits || []"
              :key="commit.hash"
              :data-git-commit="commit.hash"
              class="git-commit-row"
              :class="{
                selected: selectedHash === commit.hash,
                'search-match':
                  query && filteredMatches.some((c) => c.hash === commit.hash),
                'search-dim':
                  query && !filteredMatches.some((c) => c.hash === commit.hash),
                'main-branch-commit': rows[index]!.main,
              }"
              :style="{ '--git-graph-width': `${graphWidth}px` }"
              :aria-pressed="selectedHash === commit.hash"
              :data-git-tooltip="`${commit.subject}\n${commit.author} · ${new Date(commit.date).toLocaleString()}\n${commit.hash}`"
              @click="selectCommit(commit.hash)"
            >
              <svg
                :width="graphWidth"
                :viewBox="`0 0 ${graphWidth} 36`"
                preserveAspectRatio="none"
                height="36"
                aria-hidden="true"
              >
                <path
                  v-for="(line, i) in rows[index]!.lines"
                  :key="i"
                  :d="
                    line.incoming
                      ? curve(line.from, line.to, 18, 36)
                      : curve(line.from, line.to)
                  "
                  :stroke="
                    line.main ? '#216a9a' : colors[line.color % colors.length]
                  "
                  fill="none"
                  :stroke-width="line.main ? 3 : 1.6"
                />
                <path
                  v-if="rows[index]!.continued"
                  :d="`M ${12 + rows[index]!.index * 14} 0 V 18`"
                  :stroke="
                    rows[index]!.main
                      ? '#216a9a'
                      : colors[rows[index]!.color % colors.length]
                  "
                  :stroke-width="rows[index]!.main ? 3 : 1.6"
                />
                <circle
                  :cx="12 + rows[index]!.index * 14"
                  cy="18"
                  :r="commit.hash === history?.head ? 4.5 : 3"
                  :fill="
                    commit.hash === history?.head
                      ? 'var(--surface)'
                      : rows[index]!.main
                        ? '#216a9a'
                        : colors[rows[index]!.color % colors.length]
                  "
                  :stroke="
                    rows[index]!.main
                      ? '#216a9a'
                      : colors[rows[index]!.color % colors.length]
                  "
                  :stroke-width="rows[index]!.main ? 2.5 : 1.8"
                />
              </svg>
              <span class="git-subject"
                ><span
                  v-for="ref in history?.refs.filter(
                    (r) => r.hash === commit.hash,
                  ) || []"
                  :key="ref.fullName"
                  class="git-ref"
                  :class="[
                    `ref-${ref.kind}`,
                    { 'ref-main': ref.fullName === history?.mainRef },
                  ]"
                  ><Icon
                    :name="ref.kind === 'tag' ? 'box' : 'git'"
                    :size="10"
                  />{{ ref.name }}</span
                ><span>{{ commit.subject }}</span></span
              >
              <span class="git-author">{{ commit.author }}</span
              ><time :datetime="commit.date">{{ date(commit.date) }}</time
              ><code>{{ commit.hash.slice(0, 7) }}</code>
            </button>
            <p
              v-if="!busy && history && !history.commits.length"
              class="git-inline-message"
            >
              No commits yet{{ branch ? " on this reference" : "" }}.
            </p>
            <p v-if="busy" class="git-inline-message" role="status">
              Reading repository…
            </p>
            <button
              v-if="history?.hasMore"
              class="subtle-button git-load-more"
              :disabled="busy"
              @click="load(true)"
            >
              Load older commits
            </button>
          </div>
        </div>
        <div v-else class="git-changes">
          <p v-if="!status?.files.length" class="git-inline-message">
            Working tree clean.
          </p>
          <button
            v-for="file in status?.files || []"
            :key="file.path"
            class="git-change-row"
            :class="{ selected: selectedFile === file.path }"
            @click="selectChange(file.path, file.index)"
          >
            <span class="git-file-status">{{
              file.index === "?"
                ? "?"
                : file.index !== " "
                  ? file.index
                  : file.worktree
            }}</span
            ><span>{{ file.path }}</span
            ><small>{{
              file.index === "?"
                ? "Untracked"
                : file.index !== " "
                  ? "Staged"
                  : "Modified"
            }}</small>
          </button>
        </div>
        <div
          v-if="selectedHash || selectedFile"
          class="git-detail-resizer"
          role="separator"
          tabindex="0"
          aria-label="Resize Git details"
          aria-orientation="horizontal"
          :aria-valuenow="Math.round((1 - historyShare) * 100)"
          :aria-valuemin="18"
          :aria-valuemax="82"
          @pointerdown.stop="startResize"
          @pointermove.stop="resizeDetails"
          @pointerup="splitPointer = undefined"
          @lostpointercapture="splitPointer = undefined"
          @pointercancel="splitPointer = undefined"
          @keydown="resizeKeys"
          @dblclick="historyShare = 0.53"
        >
          <span />
        </div>
        <section
          v-if="selectedHash || selectedFile"
          class="git-detail"
          aria-label="Git details"
        >
          <header>
            <div>
              <strong>{{
                detail?.message.split("\n")[0] ||
                (detailBusy ? "Loading commit…" : selectedFile)
              }}</strong
              ><small v-if="selectedHash">{{ selectedHash }}</small>
            </div>
            <button
              class="icon-button"
              aria-label="Close Git details"
              @click="clearDetails"
            >
              <Icon name="close" :size="13" />
            </button>
          </header>
          <p v-if="detail?.message.includes('\n')" class="git-commit-message">
            {{ detail.message.split("\n").slice(1).join("\n").trim() }}
          </p>
          <div class="git-diff-layout">
            <nav
              v-if="selectedHash"
              class="git-file-list"
              aria-label="Changed files"
            >
              <button
                v-for="file in detail?.files || []"
                :key="file.path"
                :class="{ selected: selectedFile === file.path }"
                @click="selectFile(file.path)"
              >
                <span class="git-file-status">{{ file.status }}</span
                ><span>{{ file.path }}</span>
              </button>
              <p v-if="detail && !detail.files.length" class="field-help">
                No file changes against the first parent.
              </p>
            </nav>
            <div class="git-diff-content">
              <div class="git-diff-heading">
                <Icon name="file" :size="12" /><span>{{
                  selectedFile || "Select a changed file"
                }}</span
                ><CustomSelect
                  v-if="tab === 'changes'"
                  v-model="changeMode"
                  aria-label="Git diff source"
                  :options="[
                    { value: 'worktree', label: 'Working tree' },
                    { value: 'index', label: 'Staged' },
                  ]"
                  @change="selectFile(selectedFile)"
                />
              </div>
              <pre
                v-if="patch"
                class="git-patch"
                aria-label="Git diff"
              ><span v-for="(line,index) in patchLines" :key="index" :class="{added:line.startsWith('+') && !line.startsWith('+++'),removed:line.startsWith('-') && !line.startsWith('---'),hunk:line.startsWith('@@')}">{{ line }}{{ '\n' }}</span></pre>
              <p v-else class="git-inline-message">
                {{
                  detailBusy
                    ? "Reading changes…"
                    : "No text diff to display. Untracked files have no committed version to compare."
                }}
              </p>
              <p v-if="truncated" class="git-inline-message">
                This diff is truncated because of its size.
              </p>
            </div>
          </div>
        </section>
      </div>
    </template>
    <Teleport to="body"
      ><div
        v-if="tooltip"
        :id="tooltipId"
        ref="tooltipElement"
        role="tooltip"
        class="git-tooltip"
        :style="{
          left: `${tooltip.left}px`,
          top: `${tooltip.top}px`,
          width: `${tooltip.width}px`,
        }"
      >
        {{ tooltip.text }}
      </div></Teleport
    >
    <Teleport to="body"
      ><div
        v-if="picker"
        class="git-folder-backdrop"
        @pointerdown.stop
        @click.self="picker = false"
        @keydown="pickerKeys"
      >
        <section
          ref="pickerElement"
          class="git-folder-picker floating-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Add Git workspace"
          v-motion="{ kind: 'popover' }"
        >
          <div class="panel-heading">
            <h1>Add Git workspace</h1>
            <button
              class="icon-button"
              aria-label="Close folder picker"
              @click="picker = false"
            >
              <Icon name="close" />
            </button>
          </div>
          <p class="field-help">
            Choose a repository folder. It will be saved for switching between
            projects.
          </p>
          <form class="git-folder-path" @submit.prevent="browse(pathInput)">
            <input
              ref="folderInput"
              v-model="pathInput"
              aria-label="Local folder path"
              placeholder="Enter a local folder path"
            /><button class="subtle-button" :disabled="folderBusy">Go</button>
          </form>
          <div class="git-folder-navigation">
            <button
              class="subtle-button"
              :disabled="!folder?.parent || folderBusy"
              @click="browse(folder?.parent || undefined)"
            >
              <Icon name="back" :size="13" />Up</button
            ><CustomSelect
              :model-value="String('')"
              aria-label="Folder location"
              :options="[
                { value: 'home', label: 'Home' },
                ...(folder?.roots || []).map((path) => ({
                  value: path,
                  label: path,
                })),
              ]"
              placeholder="Locations"
              @update:model-value="
                browse($event === 'home' ? undefined : $event)
              "
            />
          </div>
          <p v-if="folderError" class="git-error" role="alert">
            {{ folderError }}
          </p>
          <div class="git-folder-list" :aria-busy="folderBusy">
            <p v-if="folderBusy" class="field-help">Reading folders…</p>
            <button
              v-for="item in folder?.folders || []"
              :key="item.path"
              :disabled="folderBusy"
              @click="browse(item.path)"
            >
              <Icon name="folder" :size="15" /><span>{{ item.name }}</span
              ><Icon name="right" :size="12" />
            </button>
            <p v-if="folder && !folder.folders.length" class="field-help">
              No subfolders. You can select the current folder.
            </p>
          </div>
          <label class="property"
            ><span>Workspace name (optional)</span
            ><input
              v-model="workspaceName"
              aria-label="Git workspace name"
              placeholder="Use the repository folder name"
          /></label>
          <footer>
            <span class="field-help" :title="pathInput">{{ pathInput }}</span
            ><button
              class="subtle-button"
              :disabled="folderBusy || !pathInput.trim()"
              @click="saveFolder"
            >
              <Icon name="check" :size="13" />Use this folder
            </button>
          </footer>
        </section>
      </div></Teleport
    >
  </div>
</template>
