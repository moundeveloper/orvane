<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { agentOpenRequests, agentRunIndicators } from "../agentNavigation";
import {
  agentRequest,
  type AgentSession,
  type AgentMessage,
  type AgentSessionRead,
  type VisualRecord,
} from "../exposition";
import type { Block } from "../model";
import ExpositionView from "./ExpositionView.vue";
import Icon from "./Icon.vue";
import ChatMarkdown from "./ChatMarkdown.vue";
import AgentRunActivity from "./AgentRunActivity.vue";
import ThinkingTrail from "./ThinkingTrail.vue";
import CustomSelect from "./CustomSelect.vue";
import ContextPicker from "./ContextPicker.vue";
import ComposerModes from "./ComposerModes.vue";
import FilesChanged from "./FilesChanged.vue";
import MessageActions, { type MessageAction } from "./MessageActions.vue";
import { sendToNotes } from "../agentMessageNotes";
import SlashMenu, { type SlashEntry } from "./SlashMenu.vue";
import SessionTimeline, { type SessionApproval } from "./SessionTimeline.vue";
import { registerCommands } from "../commands";
import {
  agentBusy,
  agentNames,
  agentPermissions,
  summarizeAgentRun,
  type AgentRunSummary,
  type AgentProvider,
  type AgentRun,
  type AgentActivity,
  type AgentEditMode,
  type AgentEffort,
} from "../agentSessions";
import {
  api as fileRequest,
  parentOf,
  type FileEntry,
  type Roots,
} from "./files/explorer";
const props = defineProps<{ block: Block }>();
const sessions = ref<AgentSession[]>([]),
  active = ref(""),
  search = ref(""),
  messages = ref<AgentMessage[]>([]),
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
  ticks = 0,
  // Panned off screen on the canvas: no polling until it is seen again.
  onScreen = true,
  polling = false,
  visibility: IntersectionObserver | undefined;
const root = ref<HTMLElement>();
const composer = ref<HTMLTextAreaElement>();
const folderInput = ref<HTMLInputElement>();
const searchInput = ref<HTMLInputElement>();
const newProvider = ref<AgentProvider>();
const folder = ref("");
const draft = ref("");
const run = ref<AgentRun | null>(null);
const sending = ref(false);
const runError = ref("");
const live = ref(false);
const browsing = ref(false);
const browsePath = ref("");
const folders = ref<FileEntry[]>([]);
const sessionView = ref<HTMLElement>();
const dock = ref<HTMLFormElement>();
const paths = ref<string[]>([]);
// An "@" before the caret opens the file picker; its text is the query.
const mention = ref<{ start: number; query: string } | null>(null);
// "/" at the start of the composer: skills, session commands, saved prompts.
const slash = ref<{ query: string } | null>(null);
const slashMenu = ref<InstanceType<typeof SlashMenu>>();
const slashItems = ref<SlashEntry[]>([]);
const slashLoading = ref(false);
const savedPrompts = ref<{ name: string; text: string }[]>([]);
const promptName = ref<string | null>(null);
const promptNameInput = ref<HTMLInputElement>();
const recentKey = "orvane-agent-recent-skills";
const recentSkills = ref<Record<string, string[]>>({});
try {
  recentSkills.value = JSON.parse(localStorage.getItem(recentKey) || "{}");
} catch {}
const picker = ref<InstanceType<typeof ContextPicker>>();
const rawPermissions = ref(new Set<string>());
const menuOpen = ref(false);
const menuButton = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const modelCatalogues = ref<
  Partial<Record<AgentProvider, { value: string; label: string }[]>>
>({});
const chosenModels = ref<Record<string, string>>({});
// Effort and edit mode chosen per session, like the model.
const chosenEfforts = ref<Record<string, AgentEffort | "">>({});
const chosenModes = ref<Record<string, AgentEditMode | "">>({});
const modes = ref<InstanceType<typeof ComposerModes>>();
const runStarts = new Map<string, number>();
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
let dockSize: ResizeObserver | undefined;
let stream: EventSource | undefined;
let revision = 0;
let browseRevision = 0;
try {
  active.value = JSON.parse(props.block.value || "{}").active || "";
} catch {}
const selected = computed(() =>
  sessions.value.find((s) => s.key === active.value),
);
const provider = computed(
  () => newProvider.value || selected.value?.provider || "claude",
);
const busy = computed(() => sending.value || agentBusy(run.value));
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return sessions.value.filter(
    (s) =>
      !query ||
      `${s.title} ${s.project} ${agentNames[s.provider ?? "claude"]}`
        .toLowerCase()
        .includes(query),
  );
});
const modelKey = computed(() =>
  newProvider.value ? `new:${newProvider.value}` : active.value,
);
const model = computed({
  get: () => chosenModels.value[modelKey.value] ?? "",
  set: (value: string) => {
    chosenModels.value = { ...chosenModels.value, [modelKey.value]: value };
  },
});
const effort = computed({
  get: () => chosenEfforts.value[modelKey.value] ?? "",
  set: (value: AgentEffort | "") => {
    chosenEfforts.value = { ...chosenEfforts.value, [modelKey.value]: value };
  },
});
const editMode = computed({
  get: () => chosenModes.value[modelKey.value] ?? "",
  set: (value: AgentEditMode | "") => {
    chosenModes.value = { ...chosenModes.value, [modelKey.value]: value };
  },
});
const modelOptions = computed(() => {
  const listed = modelCatalogues.value[provider.value];
  const options = listed?.length
    ? listed
    : provider.value === "claude"
      ? ["sonnet", "opus", "haiku", "fable"].map((value) => ({
          value,
          label: value[0]!.toUpperCase() + value.slice(1),
        }))
      : [];
  return [
    ...(options.some((option) => option.value === "")
      ? []
      : [{ value: "", label: "Provider default" }]),
    ...options,
  ];
});
watch(
  provider,
  (kind) => {
    if (modelCatalogues.value[kind]) return;
    void agentRequest<{ models: { value: string; label: string }[] }>(
      "models",
      { provider: kind },
    )
      .then(({ models }) => {
        modelCatalogues.value = { ...modelCatalogues.value, [kind]: models };
      })
      .catch(() => {});
  },
  { immediate: true },
);
type SessionState = "" | "running" | "approval" | "failed" | "stopped";
function stateOf(summary?: AgentRunSummary): SessionState {
  if (!summary) return "";
  if (summary.awaitingApproval) return "approval";
  if (summary.status === "running" || summary.status === "stopping")
    return "running";
  if (summary.status === "failed") return "failed";
  if (summary.status === "stopped") return "stopped";
  return "";
}
function sessionState(s: AgentSession): SessionState {
  if (s.key === active.value && run.value)
    return stateOf(summarizeAgentRun(run.value));
  let found: AgentRunSummary | undefined;
  for (const summary of agentRunIndicators.values())
    if (
      summary.sessionId &&
      summary.sessionId === s.sessionId &&
      summary.provider === (s.provider ?? "claude")
    )
      found = summary;
  return stateOf(found);
}
const stateLabels: Record<Exclude<SessionState, "">, string> = {
  running: "Running",
  approval: "Needs you",
  failed: "Failed",
  stopped: "Stopped",
};
// Runs still working that no listed session has picked up yet.
const pendingRuns = computed(() =>
  recentRuns.value.filter(
    (item) =>
      (stateOf(item) === "running" || stateOf(item) === "approval") &&
      !sessions.value.some(
        (s) =>
          !!item.sessionId &&
          s.sessionId === item.sessionId &&
          (s.provider ?? "claude") === item.provider,
      ),
  ),
);
const groups = computed(() => {
  const attention: AgentSession[] = [],
    today: AgentSession[] = [],
    earlier: AgentSession[] = [];
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  for (const s of filtered.value) {
    const state = sessionState(s);
    if (state === "running" || state === "approval") attention.push(s);
    else if (s.updatedAt >= midnight.valueOf()) today.push(s);
    else earlier.push(s);
  }
  return [
    { label: "Needs attention", items: attention, runs: pendingRuns.value },
    { label: "Today", items: today, runs: [] },
    { label: "Earlier", items: earlier, runs: [] },
  ].filter((group) => group.items.length || group.runs.length);
});
const rowTime = (value: number) => {
  const d = new Date(value),
    midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (Number.isNaN(d.valueOf())) return "";
  return d >= midnight
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const working = computed(() => agentBusy(run.value));
// Head of the thinking trail: what the run is doing as a whole.
const trailLabel = computed(() => {
  if (!run.value) return "";
  if (run.value.permissions.length) return "Waiting for your approval";
  if (run.value.status === "stopping") return "Stopping…";
  return run.value.text ? "Writing the answer" : "Thinking";
});
const elapsed = computed(() => {
  const started = run.value && runStarts.get(run.value.id);
  if (!started) return "";
  const seconds = Math.max(0, Math.round((now.value - started) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
});
watch(working, (busyNow) => {
  clearInterval(clock);
  clock = busyNow
    ? setInterval(() => {
        if (onScreen && !document.hidden) now.value = Date.now();
      }, 1000)
    : undefined;
  now.value = Date.now();
});
function permissionRows(input: string) {
  try {
    const value = JSON.parse(input);
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.entries(value).map(
        ([key, item]) =>
          [key, typeof item === "string" ? item : JSON.stringify(item)] as const,
      );
  } catch {
    /* Not JSON: show it as written. */
  }
  return null;
}
function toggleRaw(id: string) {
  const next = new Set(rawPermissions.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  rawPermissions.value = next;
}
function readMention() {
  const field = composer.value;
  if (!field || field.selectionStart !== field.selectionEnd) {
    mention.value = null;
    slash.value = null;
    return;
  }
  const before = field.value.slice(0, field.selectionStart);
  const command = /^\/([\w:.-]*)$/.exec(before);
  if (command) {
    if (!slash.value) void loadSlash();
    slash.value = { query: command[1]! };
    mention.value = null;
    return;
  }
  slash.value = null;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  mention.value = match
    ? { start: before.length - match[1]!.length - 1, query: match[1]! }
    : null;
}
// The picked file or folder becomes a context chip; its "@" text goes.
async function pickMention(entry: FileEntry) {
  const field = composer.value;
  const found = mention.value;
  if (!field || !found) return;
  const end = field.selectionStart;
  draft.value = draft.value.slice(0, found.start) + draft.value.slice(end);
  if (!paths.value.includes(entry.path))
    paths.value = [...paths.value, entry.path].slice(0, 20);
  mention.value = null;
  await nextTick();
  field.focus({ preventScroll: true });
  field.setSelectionRange(found.start, found.start);
}
async function loadSlash() {
  slashLoading.value = true;
  try {
    const data = await agentRequest<{
      items: SlashEntry[];
      prompts: { name: string; text: string }[];
    }>("slash", {
      provider: provider.value,
      folder: selected.value?.project || run.value?.folder || folder.value.trim() || undefined,
    });
    savedPrompts.value = data.prompts;
    slashItems.value = [
      ...data.items,
      ...data.prompts.map((prompt) => ({
        kind: "prompt" as const,
        name: prompt.name,
        description: "",
        text: prompt.text,
      })),
    ];
  } catch {
    slashItems.value = [];
  } finally {
    slashLoading.value = false;
  }
}
const recent = computed(() => recentSkills.value[provider.value] ?? []);
function remember(name: string) {
  const list = [name, ...recent.value.filter((item) => item !== name)].slice(0, 3);
  recentSkills.value = { ...recentSkills.value, [provider.value]: list };
  try {
    localStorage.setItem(recentKey, JSON.stringify(recentSkills.value));
  } catch {}
}
// A skill or command goes in as "/name "; a saved prompt as its text.
async function pickSlash(entry: SlashEntry) {
  const field = composer.value;
  if (!field) return;
  const end = field.selectionStart;
  const text = entry.kind === "prompt" ? entry.text ?? "" : `/${entry.name} `;
  draft.value = text + draft.value.slice(end);
  if (entry.kind !== "prompt") remember(entry.name);
  slash.value = null;
  await nextTick();
  field.focus({ preventScroll: true });
  field.setSelectionRange(text.length, text.length);
}
async function useRecent(name: string) {
  const field = composer.value;
  if (!field) return;
  draft.value = `/${name} ` + draft.value.replace(/^\/[\w:.-]*\s?/, "");
  remember(name);
  await nextTick();
  field.focus({ preventScroll: true });
  field.setSelectionRange(name.length + 2, name.length + 2);
}
async function startSavePrompt() {
  promptName.value = draft.value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
    .slice(0, 40);
  await nextTick();
  promptNameInput.value?.select();
}
async function savePrompt() {
  const name = promptName.value?.trim() ?? "";
  if (!name || !draft.value.trim()) return;
  try {
    const data = await agentRequest<{ prompts: { name: string; text: string }[] }>(
      "save-prompt",
      { name, text: draft.value },
    );
    savedPrompts.value = data.prompts;
    promptName.value = null;
    composer.value?.focus({ preventScroll: true });
  } catch (error) {
    showRunError(error);
  }
}
function promptNameKey(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void savePrompt();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    promptName.value = null;
    composer.value?.focus({ preventScroll: true });
  }
}
// Actions from a message's hover menu.
const forking = ref(false);
const notice = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showNotice(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.value = ""), 2400);
}
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-")
    .slice(0, 40) || "prompt";
async function messageAction(action: MessageAction, text: string) {
  try {
    if (action === "copy") await navigator.clipboard.writeText(text);
    else if (action === "reuse") {
      draft.value = text;
      await nextTick();
      focusComposer();
    } else if (action === "fork") startFork();
    else if (action === "notes") {
      const title =
        text.trim().split(/\r?\n/, 1)[0]!.replace(/^#+\s*/, "").slice(0, 80) || "Agent message";
      await sendToNotes(title, text);
      showNotice("Sent to Notes");
    } else if (action === "prompt") {
      const data = await agentRequest<{ prompts: { name: string; text: string }[] }>("save-prompt", {
        name: slug(text),
        text,
      });
      savedPrompts.value = data.prompts;
      showNotice(`Saved as /${slug(text)}`);
    }
  } catch (error) {
    showRunError(error);
  }
}
// The next message resumes into a new session that branches from this one.
function startFork() {
  if (provider.value !== "claude" || !selected.value) return;
  forking.value = true;
  focusComposer();
}
watch(active, () => {
  forking.value = false;
  timeline.value = false;
});
// The session timeline takes the conversation's place until closed.
const timeline = ref(false);
const approvals = ref<SessionApproval[]>([]);
async function openTimeline() {
  if (!selected.value) return;
  const sessionId = selected.value.sessionId;
  approvals.value = [];
  timeline.value = true;
  try {
    const found = await agentRequest<SessionApproval[]>("session-approvals", { sessionId });
    if (timeline.value && selected.value?.sessionId === sessionId) approvals.value = found;
  } catch (cause) {
    showRunError(cause);
  }
}
function closeTimeline() {
  timeline.value = false;
  void nextTick(() => chat.value?.focus({ preventScroll: true }));
}
// "Ask about this change" sends a follow-up that carries the file.
function askAbout(text: string, path: string) {
  draft.value = text;
  paths.value = [path];
  void send();
}
async function addContext() {
  const field = composer.value;
  if (!field) return;
  field.focus({ preventScroll: true });
  const at = field.selectionStart;
  const space = at > 0 && !/\s/.test(draft.value[at - 1]!) ? " " : "";
  draft.value = draft.value.slice(0, at) + space + "@" + draft.value.slice(at);
  await nextTick();
  field.setSelectionRange(at + space.length + 1, at + space.length + 1);
  readMention();
}
function composerKey(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (slash.value) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      slashMenu.value?.move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (
      (event.key === "Tab" && !event.shiftKey) ||
      (event.key === "Enter" && !event.shiftKey)
    ) {
      if (slashMenu.value?.pick()) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      slash.value = null;
      return;
    }
  }
  if (mention.value) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      picker.value?.move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (
      (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) &&
      picker.value?.pick()
    ) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      mention.value = null;
      return;
    }
  }
  if (event.key === "Enter") return onEnter(event);
  if (event.key === "Escape") return leaveComposer(event);
  // Shift+Tab cycles how edits are handled, as in the CLIs.
  if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    modes.value?.cycleMode();
  }
}
function appKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (
    event.key !== "/" ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    target.closest("input, textarea, [contenteditable]")
  )
    return;
  event.preventDefault();
  searchInput.value?.focus();
}
const resumeCommand = computed(() =>
  !selected.value
    ? ""
    : (selected.value.provider ?? "claude") === "codex"
      ? `codex resume ${selected.value.sessionId}`
      : `claude --resume ${selected.value.sessionId}`,
);
async function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (!menuOpen.value) return;
  await nextTick();
  menu.value?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
}
function closeMenu(restore = false) {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  if (restore) menuButton.value?.focus({ preventScroll: true });
}
function menuKey(event: KeyboardEvent) {
  const items = [
    ...(menu.value?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
  ];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  } else if (event.key === "Tab") closeMenu();
}
function outsideMenu(event: Event) {
  if (!menuOpen.value) return;
  const path = event.composedPath();
  if (![menu.value, menuButton.value].some((el) => el && path.includes(el)))
    closeMenu();
}
// The session folder opens in Orvane's File Explorer, like folder links in
// Ctrl+K and sticky notes.
function openFolder() {
  const path = selected.value?.project || run.value?.folder;
  if (!path) return;
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: {
        link: { kind: "folder", target: path, label: path.split(/[\\/]/).pop() },
      },
    }),
  );
}
async function menuAction(action: "folder" | "id" | "resume" | "reload" | "timeline") {
  closeMenu(action !== "timeline");
  try {
    if (action === "timeline") await openTimeline();
    else if (action === "folder") await openFolder();
    else if (action === "id" && selected.value)
      await navigator.clipboard.writeText(selected.value.sessionId);
    else if (action === "resume")
      await navigator.clipboard.writeText(resumeCommand.value);
    else await refresh();
  } catch (cause) {
    showRunError(cause);
  }
}
// Transcript tool calls in the same step list as a live run. A call with no
// logged result is still running if it is in the newest reply.
function toolSteps(message: AgentMessage, newest: boolean): AgentActivity[] {
  return message.tools.map((tool) => {
    const mcp = /^mcp__([^]+?)__(.+)$/.exec(tool.name);
    return {
      id: tool.id,
      kind: mcp
        ? "mcp"
        : /^(Bash|shell|exec_command|local_shell_call)$/.test(tool.name)
          ? "command"
          : /^(WebSearch|web_search)$/.test(tool.name)
            ? "search"
            : "tool",
      label: mcp ? `${mcp[1]} / ${mcp[2]}` : tool.name,
      status: tool.status ?? (newest ? "running" : "interrupted"),
      ...(tool.input ? { input: tool.input } : {}),
      ...(tool.output ? { output: tool.output } : {}),
      ...(tool.startedAt ? { startedAt: tool.startedAt } : {}),
      ...(tool.endedAt ? { endedAt: tool.endedAt } : {}),
    };
  });
}
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
  const data = await agentRequest<{
    sessions: AgentSession[];
    runs: AgentRunSummary[];
  }>("sessions");
  sessions.value = data.sessions;
  for (const summary of [...data.runs].reverse()) recordIndicator(summary);
  if (active.value && !data.sessions.some((s) => s.key === active.value)) {
    active.value = "";
    messages.value = [];
    visuals.value = [];
  }
}
const recentRuns = computed(() =>
  [...agentRunIndicators.values()].reverse().slice(0, 5),
);
function recordIndicator(summary: AgentRunSummary) {
  agentRunIndicators.set(summary.id, summary);
  if (agentRunIndicators.size > 20) {
    const oldest = agentRunIndicators.keys().next().value;
    if (oldest) agentRunIndicators.delete(oldest);
  }
}
async function openRecent(id: string) {
  try {
    const value = await agentRequest<AgentRun | null>("inspect-run", { id });
    if (!value) throw Error("This run is no longer available.");
    const session = sessions.value.find(
      (item) =>
        item.sessionId === value.sessionId &&
        (item.provider ?? "claude") === value.provider,
    );
    back();
    if (session && !agentBusy(value)) {
      await select(session.key);
      if (value.error) showRunError(value.error);
    } else {
      newProvider.value = value.provider;
      folder.value = value.folder;
      watchRun(value);
    }
  } catch (cause) {
    showRunError(cause);
  }
}
function resetComposer() {
  revision++;
  browseRevision++;
  closeStream();
  run.value = null;
  runError.value = "";
  draft.value = "";
  sending.value = false;
  live.value = false;
  browsing.value = false;
  paths.value = [];
  mention.value = null;
  rawPermissions.value = new Set();
  menuOpen.value = false;
}

async function browse(path?: string) {
  const request = ++browseRevision;
  browsing.value = true;
  runError.value = "";
  try {
    const roots = await fileRequest<Roots>("roots");
    const directory = path || roots.home;
    const entries = await fileRequest<{ entries: FileEntry[] }>("list", {
      path: directory,
    });
    if (request !== browseRevision) return;
    browsePath.value = directory;
    folders.value = entries.entries.filter((entry) => entry.dir);
  } catch (error) {
    if (request === browseRevision) runError.value = (error as Error).message;
  }
}

function closeBrowser() {
  browseRevision++;
  browsing.value = false;
}

async function openNew(kind: AgentProvider) {
  if (sending.value || (newProvider.value && busy.value)) return;
  const project = selected.value?.project;
  back();
  newProvider.value = kind;
  if (project) folder.value = project;
  await nextTick();
  folderInput.value?.focus();
}

async function focusComposer() {
  if (expanded.value) await collapse();
  if (selected.value || newProvider.value) composer.value?.focus();
  else searchInput.value?.focus();
}

async function present(value: AgentRun) {
  const ticket = revision;
  if (agentBusy(value) && !runStarts.has(value.id))
    runStarts.set(value.id, Date.now());
  recordIndicator(summarizeAgentRun(value));
  run.value = value;
  if (!agentBusy(value)) {
    if (value.error) runError.value = value.error;
    if (value.status === "failed" && !draft.value && !value.text)
      draft.value = value.message;
    if (newProvider.value && value.sessionId) {
      await list();
      const session = sessions.value.find(
        (s) =>
          (s.provider ?? "claude") === value.provider &&
          s.sessionId === value.sessionId,
      );
      if (session && ticket === revision) {
        await select(session.key);
        return;
      }
    } else if (active.value) {
      await read();
      if (
        ticket === revision &&
        messages.value.some(
          (message) =>
            message.role === "user" && message.text === value.message,
        )
      )
        live.value = false;
    }
  }
  await nextTick();
  if (live.value && chat.value && ticket === revision)
    chat.value.scrollTop = chat.value.scrollHeight;
}

function watchRun(value: AgentRun) {
  live.value = true;
  closeStream();
  void present(value).catch(showRunError);
  syncStream();
}

function closeStream() {
  stream?.close();
  stream = undefined;
}

function syncStream() {
  if (!onScreen || document.hidden) {
    closeStream();
    return;
  }
  const value = run.value;
  if (!value || !agentBusy(value) || stream) return;
  const ticket = revision;
  const source = new EventSource(
    `/__orvane/agents/run-events?id=${encodeURIComponent(value.id)}`,
  );
  stream = source;
  source.onmessage = ({ data }) => {
    if (ticket !== revision || stream !== source) return;
    const next = JSON.parse(data) as AgentRun;
    if (!agentBusy(next)) closeStream();
    void present(next).catch((error) => {
      if (ticket === revision) showRunError(error);
    });
  };
  source.onerror = () => {
    if (stream !== source || source.readyState !== EventSource.CLOSED) return;
    closeStream();
    const message =
      "The connection to this run closed. Reopen the session to check its transcript.";
    run.value = { ...value, status: "failed", permissions: [], error: message };
    showRunError(message);
  };
}

function showRunError(error: unknown) {
  runError.value =
    error instanceof Error ? error.message : "Session command failed.";
}

async function send() {
  if (
    busy.value ||
    !draft.value.trim() ||
    !(selected.value || newProvider.value)
  )
    return;
  if (newProvider.value && !folder.value.trim()) {
    folderInput.value?.focus();
    return;
  }
  const ticket = revision;
  sending.value = true;
  runError.value = "";
  try {
    const message = paths.value.length
      ? `${draft.value}\n\nLocal attachments:\n${paths.value.map((path) => JSON.stringify(path)).join("\n")}`
      : draft.value;
    const chosen = {
      ...(model.value ? { model: model.value } : {}),
      ...(effort.value ? { effort: effort.value } : {}),
      ...(editMode.value ? { mode: editMode.value } : {}),
      ...(forking.value && !newProvider.value ? { fork: true } : {}),
    };
    const result = await agentRequest<AgentRun>("start", {
      message,
      target: newProvider.value
        ? { provider: newProvider.value, folder: folder.value.trim(), ...chosen }
        : { key: active.value, ...chosen },
    });
    if (ticket !== revision) return;
    draft.value = "";
    paths.value = [];
    mention.value = null;
    forking.value = false;
    closeBrowser();
    watchRun(result);
  } catch (error) {
    if (ticket === revision) showRunError(error);
  } finally {
    if (ticket === revision) sending.value = false;
  }
}

function onEnter(event: KeyboardEvent) {
  if (event.shiftKey || event.isComposing) return;
  event.preventDefault();
  void send();
}
function leaveComposer(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  composer.value?.blur();
}

async function runCommand(
  operation: string,
  args: Record<string, unknown> = {},
) {
  if (!run.value) return;
  const ticket = revision;
  try {
    await agentRequest(operation, { id: run.value.id, ...args });
  } catch (error) {
    if (ticket === revision) showRunError(error);
  }
}
async function read(older = false, includeRun = false) {
  if (!active.value) return;
  const key = active.value,
    gen = generation;
  const box = chat.value,
    atBottom =
      !box || box.scrollHeight - box.scrollTop - box.clientHeight < 100,
    oldHeight = box?.scrollHeight || 0;
  const data = await agentRequest<AgentSessionRead>("read", {
    key,
    ...(includeRun ? { includeRun: true } : {}),
    ...(older && before.value ? { before: before.value } : {}),
  });
  if (gen !== generation || key !== active.value) return;
  if (!sessions.value.some((session) => session.key === key))
    sessions.value = [data.session, ...sessions.value];
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
  if (data.run && agentBusy(data.run)) watchRun(data.run);
  else if (data.run) {
    run.value = data.run;
    if (data.run.error) showRunError(data.run.error);
  }
  await nextTick();
  if (chat.value && !expanded.value) {
    if (older) chat.value.scrollTop += chat.value.scrollHeight - oldHeight;
    else if (atBottom) chat.value.scrollTop = chat.value.scrollHeight;
  }
}
async function select(key: string) {
  if (sending.value || (newProvider.value && busy.value)) return;
  resetComposer();
  newProvider.value = undefined;
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
    await read(false, true);
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
  if (stopped || polling) return;
  polling = true;
  try {
    if (!document.hidden && onScreen) {
      if (ticks++ % 3 === 0) {
        const restoring = ticks === 1 && first && !!active.value;
        await list();
        if (restoring && active.value && !loading.value)
          await select(active.value);
      }
      if (active.value && !busy.value && !loading.value && !olderBusy.value)
        await read();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Session updates paused.";
  } finally {
    polling = false;
    clearTimeout(timer);
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
  resetComposer();
  generation++;
  active.value = "";
  props.block.value = "";
  expanded.value = null;
  newProvider.value = undefined;
  messages.value = [];
  visuals.value = [];
  warnings.value = [];
  before.value = null;
  loading.value = false;
}
const unregister = registerCommands(`agent-sessions:${props.block.id}`, () => [
  {
    id: `agent-send:${props.block.id}`,
    title: "Send to session…",
    icon: "text",
    blockId: props.block.id,
    run: focusComposer,
  },
  ...(messages.value.some((m) => m.role !== "user" && m.text)
    ? [
        {
          id: `agent-copy-reply:${props.block.id}`,
          title: "Copy last agent reply",
          icon: "copy",
          blockId: props.block.id,
          run: () =>
            messageAction("copy", [...messages.value].reverse().find((m) => m.role !== "user" && m.text)!.text),
        },
      ]
    : []),
  ...(selected.value
    ? [
        {
          id: `agent-timeline:${props.block.id}`,
          title: "Show session timeline",
          icon: "clock",
          blockId: props.block.id,
          run: openTimeline,
        },
      ]
    : []),
  ...(provider.value === "claude" && selected.value
    ? [
        {
          id: `agent-fork:${props.block.id}`,
          title: "Fork this session",
          icon: "git",
          blockId: props.block.id,
          run: startFork,
        },
      ]
    : []),
  ...(["claude", "codex"] as const).map((kind) => ({
    id: `agent-new:${kind}:${props.block.id}`,
    title: `New ${agentNames[kind]} session…`,
    icon: "plus",
    blockId: props.block.id,
    run: () => openNew(kind),
  })),
]);
onMounted(() => {
  document.addEventListener("visibilitychange", syncStream);
  document.addEventListener("pointerdown", outsideMenu, true);
  window.addEventListener("orvane:guest-pointer-down", outsideMenu);
  // The composer floats over the chat; keep the last message and the
  // scrollbar clear of it.
  dockSize = new ResizeObserver(() =>
    sessionView.value?.style.setProperty(
      "--cs-dock-h",
      `${(dock.value?.offsetHeight ?? 0) + 12}px`,
    ),
  );
  void poll();
  if (root.value)
    visibility = new IntersectionObserver(([entry]) => {
      const was = onScreen;
      onScreen = !!entry?.isIntersecting;
      syncStream();
      // Back on screen: read now rather than at the next tick.
      if (onScreen && !was) {
        ticks = 0;
        clearTimeout(timer);
        void poll();
      }
    });
  visibility?.observe(root.value!);
});
watch(
  dock,
  (element, previous) => {
    if (previous) dockSize?.unobserve(previous);
    if (element) dockSize?.observe(element);
    else sessionView.value?.style.setProperty("--cs-dock-h", "16px");
  },
  { flush: "post" },
);
watch(
  () => agentOpenRequests.get(props.block.id),
  (request) => {
    if (!request) return;
    agentOpenRequests.delete(props.block.id);
    if ("key" in request) {
      resetComposer();
      newProvider.value = undefined;
      void select(request.key).then(focusComposer);
      return;
    }
    back();
    newProvider.value = request.run.provider;
    folder.value = request.run.folder;
    watchRun(request.run);
  },
  { immediate: true, flush: "post" },
);
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", syncStream);
  document.removeEventListener("pointerdown", outsideMenu, true);
  window.removeEventListener("orvane:guest-pointer-down", outsideMenu);
  dockSize?.disconnect();
  clearInterval(clock);
  unregister();
  resetComposer();
  visibility?.disconnect();
  stopped = true;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <div ref="root" class="agent-sessions-app" @keydown="appKey">
    <header class="cs-toolbar">
      <span class="cs-title"
        ><Icon name="agent-sessions" :size="16" /><span>Agent sessions</span></span
      >
      <button
        type="button"
        class="cs-btn"
        title="New Claude Code session"
        :disabled="sending || (!!newProvider && busy)"
        @click="openNew('claude')"
      >
        <Icon name="plus" :size="14" />Claude
      </button>
      <button
        type="button"
        class="cs-btn"
        title="New Codex session"
        :disabled="sending || (!!newProvider && busy)"
        @click="openNew('codex')"
      >
        <Icon name="plus" :size="14" />Codex
      </button>
      <button
        class="cs-btn cs-icon cs-ghost"
        type="button"
        title="Refresh"
        aria-label="Refresh agent sessions"
        @click="refresh"
      >
        <Icon name="refresh" :size="14" />
      </button>
    </header>
    <p v-if="error" class="cs-error" role="alert">
      {{ error }}
      <button type="button" class="cs-btn" @click="refresh">Retry</button>
    </p>
    <div
      class="cs-layout"
      :class="{
        'cs-has-selection': active || newProvider,
        'cs-focus': expanded,
      }"
    >
      <nav v-show="!expanded" class="cs-sidebar" aria-label="Agent sessions">
        <label class="cs-search"
          ><Icon name="search" :size="14" /><input
            ref="searchInput"
            v-model="search"
            type="text"
            placeholder="Find a session"
            aria-label="Find a session"
            aria-keyshortcuts="/"
            @keydown.esc.stop="searchInput?.blur()"
          /><kbd>/</kbd></label
        >
        <div class="cs-session-list">
          <template v-for="group in groups" :key="group.label">
            <p class="cs-group">
              {{ group.label }} <b>{{ group.items.length + group.runs.length }}</b>
            </p>
            <button
              v-for="item in group.runs"
              :key="item.id"
              type="button"
              class="cs-session"
              :disabled="sending"
              @click="openRecent(item.id)"
            >
              <strong :title="item.title">{{ item.title }}</strong>
              <span class="cs-row-meta">
                <span class="cs-prov" :class="item.provider">{{
                  agentNames[item.provider]
                }}</span>
                <span class="cs-path" :title="item.folder">{{
                  projectName(item.folder)
                }}</span>
                <span class="cs-state" :class="stateOf(item)">{{
                  stateLabels[stateOf(item) || "running"]
                }}</span>
              </span>
            </button>
            <button
              v-for="s in group.items"
              :key="s.key"
              type="button"
              class="cs-session"
              :class="{ selected: active === s.key }"
              :aria-current="active === s.key ? 'true' : undefined"
              :disabled="sending || (!!newProvider && busy)"
              @click="select(s.key)"
            >
              <strong :title="s.title">{{ s.title }}</strong
              ><time :datetime="new Date(s.updatedAt).toISOString()">{{
                rowTime(s.updatedAt)
              }}</time>
              <span class="cs-row-meta">
                <span class="cs-prov" :class="s.provider ?? 'claude'">{{
                  agentNames[s.provider ?? "claude"]
                }}</span>
                <span class="cs-path" :title="s.project">{{
                  projectName(s.project)
                }}</span>
                <span
                  v-if="sessionState(s)"
                  class="cs-state"
                  :class="sessionState(s)"
                  >{{ stateLabels[sessionState(s) as "running"] }}</span
                >
              </span>
            </button>
          </template>
          <p v-if="!groups.length" class="cs-empty">
            {{ search ? "No matching sessions." : "No local sessions found." }}
          </p>
        </div>
      </nav>
      <div v-if="active || newProvider" ref="sessionView" class="cs-session-view">
        <header v-show="!expanded" class="cs-session-header">
          <button
            class="cs-btn cs-ghost cs-back"
            type="button"
            :disabled="sending || (!!newProvider && busy)"
            @click="back"
          >
            <Icon name="back" :size="14" />Sessions
          </button>
          <div class="cs-head-text">
            <strong>{{
              newProvider
                ? `New ${agentNames[newProvider]} session`
                : selected?.title || "Session"
            }}</strong>
            <span class="cs-head-meta">
              <span>{{ agentNames[provider] }}</span>
              <template v-if="selected || folder">
                <span class="cs-sep">·</span>
                <span class="cs-path" :title="selected?.project || folder">{{
                  selected?.project || folder
                }}</span>
              </template>
              <template v-if="run && (working || run.status === 'failed' || run.status === 'stopped')">
                <span class="cs-sep">·</span>
                <span class="cs-head-state" :class="stateOf(summarizeAgentRun(run))">{{
                  stateLabels[stateOf(summarizeAgentRun(run)) || "running"]
                }}</span>
              </template>
            </span>
          </div>
          <button
            v-if="selected || (newProvider && run)"
            class="cs-btn cs-open-folder"
            type="button"
            title="Open folder"
            @click="openFolder"
          >
            <Icon name="folder" :size="14" /><span>Open folder</span>
          </button>
          <span v-if="selected" class="cs-menu-anchor">
            <button
              ref="menuButton"
              class="cs-btn cs-icon cs-ghost"
              type="button"
              aria-label="More session actions"
              aria-haspopup="menu"
              :aria-expanded="menuOpen"
              @click="toggleMenu"
            >
              <Icon name="more" :size="14" />
            </button>
            <div
              v-if="menuOpen"
              ref="menu"
              class="cs-menu select-popover"
              role="menu"
              aria-label="Session actions"
              @keydown="menuKey"
            >
              <button type="button" role="menuitem" @click="menuAction('folder')">
                <Icon name="folder-open" :size="14" /><span>Open folder</span>
              </button>
              <button type="button" role="menuitem" @click="menuAction('id')">
                <Icon name="copy" :size="14" /><span>Copy session ID</span>
              </button>
              <button type="button" role="menuitem" @click="menuAction('resume')">
                <Icon name="terminal" :size="14" /><span>Copy resume command</span>
              </button>
              <button type="button" role="menuitem" @click="menuAction('timeline')">
                <Icon name="clock" :size="14" /><span>Session timeline</span>
              </button>
              <hr />
              <button type="button" role="menuitem" @click="menuAction('reload')">
                <Icon name="refresh" :size="14" /><span>Reload transcript</span>
              </button>
            </div>
          </span>
        </header>
        <div class="cs-content">
          <div
            v-show="!expanded"
            ref="chat"
            class="cs-chat"
            aria-label="Session conversation"
          >
            <SessionTimeline
              v-if="timeline && selected"
              class="cs-timeline"
              :messages="messages"
              :approvals="approvals"
              :base="selected.project"
              @close="closeTimeline"
            />
            <div v-show="!timeline" class="cs-thread">
              <button
                v-if="before"
                type="button"
                class="cs-btn cs-older"
                :disabled="olderBusy"
                @click="older"
              >
                {{ olderBusy ? "Loading…" : "Load earlier messages" }}
              </button>
              <p v-if="loading" class="cs-empty" role="status">
                Reading session…
              </p>
              <div v-if="newProvider && !live && !run" class="cs-hello">
                <span class="cs-mark cs-mark-lg"><Icon name="ai" :size="20" /></span>
                <strong>New {{ agentNames[newProvider] }} session</strong>
                <span>{{ agentPermissions[newProvider] }}</span>
              </div>
              <p
                v-if="!newProvider && !live && !loading && !messages.length"
                class="cs-empty"
              >
                No readable conversation messages yet.
              </p>
              <p v-for="warning in warnings" :key="warning" class="cs-warning">
                {{ warning }}
              </p>
              <article
                v-for="(m, index) in messages"
                :key="m.id"
                class="cs-message"
                :class="'cs-' + m.role"
              >
                <div class="cs-message-meta">
                  <span v-if="m.role !== 'user'" class="cs-mark"
                    ><Icon name="ai" :size="12"
                  /></span>
                  <strong>{{
                    m.role === "user" ? "You" : agentNames[provider]
                  }}</strong
                  ><time>{{ time(m.at) }}</time>
                  <MessageActions
                    v-if="m.text"
                    :user="m.role === 'user'"
                    :can-fork="provider === 'claude' && !!selected"
                    @action="messageAction($event, m.text)"
                  />
                </div>
                <ChatMarkdown
                  v-if="m.text"
                  class="cs-message-text"
                  :text="m.text"
                  :base="selected?.project || run?.folder"
                />
                <span v-if="m.truncated" class="cs-muted"
                  >Message shortened for display. The transcript is
                  unchanged.</span
                >
                <AgentRunActivity
                  v-if="m.tools.length"
                  class="cs-tool-steps"
                  :title="m.tools.length === 1 ? 'Tool call' : 'Tool calls'"
                  collapsed
                  :items="toolSteps(m, index === messages.length - 1)"
                />
                <ExpositionView
                  v-for="v in attachment.map.get(m.id) || []"
                  :key="v.view.id"
                  :visual="v"
                  @expand="expand"
                />
              </article>
              <article v-if="live && run" class="cs-message cs-user">
                <div class="cs-message-meta"><strong>You</strong></div>
                <ChatMarkdown class="cs-message-text" :text="run.message" />
              </article>
              <ThinkingTrail
                v-if="working && run"
                :key="'trail:' + run.id"
                :items="run.activities ?? []"
                :base="run.folder"
                :pending="!run.text && !run.permissions.length"
                :status="run.permissions.length ? '' : run.activity"
              >
                <template #head>
                  <span class="cs-mark cs-working"><Icon name="ai" :size="12" /></span>
                  <span class="cs-dna" aria-hidden="true"
                    ><span
                      v-for="k in 9"
                      :key="k"
                      :style="{
                        left: `${(k - 1) * 4.5}px`,
                        animationDelay: `${-((10 - k) * 1.74) / 7}s`,
                      }"
                      ><b /><i /><i /></span
                  ></span>
                  <strong class="cs-trail-state">{{ trailLabel }}</strong>
                  <time v-if="elapsed" class="cs-trail-time">{{ elapsed }}</time>
                </template>
              </ThinkingTrail>
              <AgentRunActivity
                v-else-if="run?.activities?.length"
                :key="run.id"
                :items="run.activities"
              />
              <FilesChanged
                v-if="run && !working"
                :key="'files:' + run.id"
                :run-id="run.id"
                :folder="run.folder"
                @ask="askAbout"
              />
              <article v-if="live && run?.text" class="cs-message cs-live">
                <div class="cs-message-meta">
                  <span class="cs-mark"
                    ><Icon name="ai" :size="12"
                  /></span>
                  <strong>{{ agentNames[run.provider] }}</strong>
                </div>
                <ChatMarkdown
                  class="cs-message-text"
                  :text="run.text"
                  :base="run.folder"
                />
              </article>
              <section v-if="attachment.loose.length" class="cs-loose">
                <h3>Session visuals</h3>
                <span class="cs-muted"
                  >Not attached to a loaded message. Earlier messages may
                  contain the tool call.</span
                ><ExpositionView
                  v-for="v in attachment.loose"
                  :key="v.view.id"
                  :visual="v"
                  @expand="expand"
                />
              </section>
            </div>
          </div>
          <section
            v-if="expanded"
            class="cs-expanded"
            aria-label="Expanded explanation"
            @keydown.esc.stop="collapse"
          >
            <header>
              <strong>Explanation</strong
              ><button
                ref="returnToChat"
                type="button"
                class="cs-btn"
                @click="collapse"
              >
                <Icon name="close" :size="14" />Back to chat
              </button>
            </header>
            <ExpositionView :visual="expanded" expanded />
          </section>
        </div>
        <form
          v-if="!expanded && (newProvider || selected)"
          ref="dock"
          class="cs-compose"
          @submit.prevent="send"
        >
          <!-- Outside the dock, which scrolls and would clip it. -->
          <div v-if="slash" class="cs-picker-anchor">
            <SlashMenu
              ref="slashMenu"
              :query="slash.query"
              :items="slashItems"
              :loading="slashLoading"
              @pick="pickSlash"
            />
          </div>
          <div v-if="mention" class="cs-picker-anchor">
            <ContextPicker
              ref="picker"
              :query="mention.query"
              :base="selected?.project || run?.folder || undefined"
              @pick="pickMention"
            />
          </div>
          <div class="cs-dock">
            <div v-if="newProvider" class="cs-folder cs-card">
              <label>
                <span>Project folder</span>
                <input
                  ref="folderInput"
                  v-model="folder"
                  :disabled="busy"
                  required
                  placeholder="Absolute folder path"
                />
              </label>
              <button
                v-if="!browsing"
                type="button"
                class="cs-btn"
                :disabled="busy"
                @click="browse(folder || undefined)"
              >
                Browse
              </button>
              <button v-else type="button" class="cs-btn" @click="closeBrowser">
                Close folders
              </button>
            </div>
            <div
              v-if="browsing"
              class="cs-folder-picker cs-card"
              aria-label="Browse project folders"
            >
              <div v-if="browsePath" class="cs-compose-actions">
                <button
                  type="button"
                  class="cs-btn"
                  :disabled="!parentOf(browsePath)"
                  @click="browse(parentOf(browsePath) ?? undefined)"
                >
                  Up
                </button>
                <span class="cs-muted cs-grow">{{ browsePath }}</span>
                <button
                  type="button"
                  class="cs-btn"
                  @click="
                    folder = browsePath;
                    closeBrowser();
                    composer?.focus();
                  "
                >
                  Use this folder
                </button>
              </div>
              <div class="cs-folders">
                <button
                  v-for="entry in folders"
                  :key="entry.path"
                  type="button"
                  class="cs-btn cs-ghost"
                  @click="browse(entry.path)"
                >
                  <Icon name="folder" :size="14" />{{ entry.name }}
                </button>
              </div>
            </div>
            <div
              v-for="permission in run?.permissions"
              :key="permission.id"
              class="cs-permission"
              role="group"
              :aria-label="`Permission request for ${permission.tool}`"
            >
              <div class="cs-perm-head">
                <Icon name="lock" :size="14" />
                <span
                  ><strong>{{ agentNames[run!.provider] }}</strong> requests
                  <code>{{ permission.tool }}</code></span
                >
              </div>
              <template v-if="permission.input">
                <dl
                  v-if="
                    permissionRows(permission.input) &&
                    !rawPermissions.has(permission.id)
                  "
                >
                  <template
                    v-for="[key, value] in permissionRows(permission.input)!"
                    :key="key"
                  >
                    <dt>{{ key }}</dt>
                    <dd>{{ value }}</dd>
                  </template>
                </dl>
                <pre v-else>{{ permission.input }}</pre>
              </template>
              <p v-else>This request is too large to display.</p>
              <div class="cs-compose-actions">
                <button
                  v-if="permission.input && permissionRows(permission.input)"
                  type="button"
                  class="cs-btn cs-ghost"
                  :aria-pressed="rawPermissions.has(permission.id)"
                  @click="toggleRaw(permission.id)"
                >
                  Raw input
                </button>
                <span class="cs-grow" />
                <button
                  type="button"
                  class="cs-btn"
                  @click="
                    runCommand('permission', {
                      requestId: permission.id,
                      allow: false,
                    })
                  "
                >
                  Deny
                </button>
                <button
                  type="button"
                  class="cs-btn cs-allow"
                  :disabled="!permission.input"
                  @click="
                    runCommand('permission', {
                      requestId: permission.id,
                      allow: true,
                    })
                  "
                >
                  Allow once
                </button>
              </div>
            </div>
            <p v-if="notice" class="cs-notice" role="status">{{ notice }}</p>
            <p v-if="forking" class="cs-notice cs-forking" role="status">
              <Icon name="git" :size="12" />The next message starts a new session branched from this one.
              <button type="button" class="cs-btn cs-ghost cs-small" @click="forking = false">Cancel</button>
            </p>
            <p v-if="runError" class="cs-run-error cs-card" role="alert">
              {{ runError }}
            </p>
            <div class="agent-composer cs-composer">
              <textarea
                ref="composer"
                v-model="draft"
                aria-label="Message"
                placeholder="Write a message…"
                rows="2"
                maxlength="12000"
                aria-keyshortcuts="Enter Shift+Enter Escape @ / Shift+Tab"
                @keydown="composerKey"
                @input="readMention"
                @click="readMention"
                @keyup.left.right.home.end="readMention"
                @blur="(mention = null), (slash = null)"
              />
              <div class="cs-context">
                <button
                  type="button"
                  class="cs-btn cs-ghost cs-small"
                  :aria-expanded="Boolean(mention)"
                  @pointerdown.prevent
                  @click="addContext"
                >
                  <Icon name="attachment" :size="13" />Add context <kbd>@</kbd>
                </button>
                <span v-for="path in paths" :key="path" class="cs-attachment" :title="path"
                  ><Icon
                    :name="/\.[\w-]{1,8}$/.test(path) ? 'file' : 'folder'"
                    :size="12" /><span>{{ projectName(path) }}</span
                  ><button
                    type="button"
                    :aria-label="`Remove ${path}`"
                    @click="paths = paths.filter((item) => item !== path)"
                  >
                    <Icon name="close" :size="12" /></button
                ></span>
                <span class="cs-skills">
                  <Icon v-if="recent.length" name="clock" :size="12" class="cs-skills-icon" />
                  <button
                    v-for="name in recent"
                    :key="name"
                    type="button"
                    class="cs-skill"
                    :title="`Use /${name}`"
                    @pointerdown.prevent
                    @click="useRecent(name)"
                  >
                    /{{ name }}
                  </button>
                  <input
                    v-if="promptName !== null"
                    ref="promptNameInput"
                    v-model="promptName"
                    class="cs-prompt-name"
                    aria-label="Prompt name"
                    placeholder="prompt-name"
                    maxlength="40"
                    @keydown="promptNameKey"
                    @blur="promptName = null"
                  />
                  <button
                    v-else
                    type="button"
                    class="cs-skill cs-skill-add"
                    :disabled="!draft.trim()"
                    title="Save this message as a prompt for /"
                    @pointerdown.prevent
                    @click="startSavePrompt"
                  >
                    <Icon name="plus" :size="11" />Save prompt
                  </button>
                </span>
              </div>
              <div class="cs-compose-actions">
                <CustomSelect
                  v-model="model"
                  class="cs-model"
                  aria-label="Model"
                  :options="modelOptions"
                  search-label="Find a model"
                  trigger-icon="cpu"
                  prefer-above
                  :disabled="busy"
                />
                <ComposerModes
                  ref="modes"
                  v-model:effort="effort"
                  v-model:mode="editMode"
                  :provider="provider"
                  :disabled="busy"
                />
                <span
                  v-if="selected || folder"
                  class="cs-folder-chip"
                  :title="selected?.project || folder"
                  ><Icon name="folder" :size="13" /><span>{{
                    projectName(selected?.project || folder)
                  }}</span></span
                >
                <span
                  v-if="busy"
                  class="cs-status cs-running"
                  role="status"
                  >{{
                    run?.permissions.length
                      ? "Waiting for approval"
                      : run?.status === "stopping"
                        ? "Stopping…"
                        : "Running"
                  }}</span
                >
                <span
                  v-else-if="run?.status === 'stopped'"
                  class="cs-status"
                  role="status"
                  >Stopped</span
                >
                <span v-else class="cs-status" :title="agentPermissions[provider]">{{
                  agentPermissions[provider]
                }}</span>
                <button
                  v-if="busy"
                  type="button"
                  class="cs-btn cs-stop"
                  :disabled="!agentBusy(run) || run?.status === 'stopping'"
                  @click="runCommand('stop')"
                >
                  Stop
                </button>
                <button
                  v-else
                  type="submit"
                  class="cs-btn cs-primary cs-send"
                  aria-label="Send"
                  title="Send"
                  :disabled="!draft.trim() || (!!newProvider && !folder.trim())"
                >
                  <Icon name="up" :size="16" />
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
      <div v-else class="cs-welcome">
        <Icon name="agent-sessions" :size="24" /><strong
          >Choose a session or start a new one</strong
        >
      </div>
    </div>
  </div>
</template>
<style scoped>
.agent-sessions-app {
  --cs-strong: #273f50;
  --cs-muted: #5d7381;
  --cs-line: #e1e8ec;
  --cs-line2: #d5e0e5;
  --cs-hover: #e5edf2;
  --cs-run: #365f78;
  --cs-fail: #8c4637;
  --cs-wait: #7d5a1f;
  --cs-mono: "Cascadia Code", "JetBrains Mono", Consolas, ui-monospace,
    monospace;
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  color: #455968;
  container-type: inline-size;
  overflow: hidden;
  font-size: 13px;
}
.agent-sessions-app button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.cs-btn {
  justify-content: center;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--cs-line2);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  white-space: nowrap;
  line-height: 1;
}
.cs-btn:hover {
  background: var(--cs-hover);
}
.cs-btn:disabled {
  opacity: 0.5;
  cursor: default;
  background: transparent;
}
.cs-ghost {
  border-color: transparent;
}
.cs-icon {
  width: 28px;
  padding: 0;
}
.cs-primary {
  color: var(--cs-strong);
  background: #dce9ef;
  border-color: #bacfd9;
}
.cs-primary:hover {
  background: #d1e2ea;
}
.agent-sessions-app kbd {
  font: inherit;
  font-size: 10px;
  line-height: 14px;
  padding: 0 4px;
  border: 1px solid #c4d4dd;
  border-radius: 3px;
  color: var(--cs-muted);
}
.cs-muted {
  color: var(--cs-muted);
  font-size: 12px;
}
.cs-grow {
  flex: 1;
  min-width: 0;
}
.cs-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--cs-line);
  flex-shrink: 0;
}
.cs-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  color: var(--cs-strong);
  font-weight: 600;
}
.cs-title span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-layout {
  display: grid;
  grid-template-columns: 268px minmax(0, 1fr);
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
  border-right: 1px solid var(--cs-line);
}
.cs-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 10px 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--cs-line2);
  border-radius: 7px;
  background: #fbfcfd;
  color: var(--cs-muted);
}
.cs-search:focus-within {
  border-color: #7b97a7;
}
.cs-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: #455968;
  font-size: 12.5px;
  padding: 0;
}
.cs-search input::placeholder {
  color: #8296a2;
}
.cs-session-list {
  overflow: auto;
  min-height: 0;
  padding: 2px 6px 12px;
}
.cs-group {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 8px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--cs-muted);
}
.cs-group b {
  font-weight: 500;
  color: #7c909c;
}
.agent-sessions-app .cs-session {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1px 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  text-align: left;
}
.cs-session:hover {
  background: var(--cs-hover);
}
.cs-session.selected {
  background: #dde8ee;
}
.cs-session:disabled {
  opacity: 0.55;
}
.cs-session strong {
  font-weight: 550;
  color: var(--cs-strong);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-session time {
  font-size: 11px;
  color: #7c909c;
  align-self: center;
}
.cs-row-meta {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--cs-muted);
}
.cs-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-prov {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.cs-prov::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9db0bc;
}
.cs-prov.codex::before {
  border-radius: 1.5px;
  background: #8a9fae;
}
.cs-state {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: 9px;
  font-size: 10.5px;
  font-weight: 550;
}
.cs-state.running {
  color: var(--cs-run);
  background: #e1ecf2;
}
.cs-state.approval {
  color: var(--cs-wait);
  background: #f5eee1;
  box-shadow: inset 0 0 0 1px #e6d6b8;
}
.cs-state.stopped {
  color: var(--cs-muted);
  background: #edf1f3;
}
.cs-state.failed {
  color: var(--cs-fail);
  background: #f4e7e3;
}
.cs-session-view {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.cs-session-header {
  position: absolute;
  inset: 0 0 auto;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 50px;
  padding: 8px 12px 8px 16px;
  background: rgb(247 250 252 / 8%);
  backdrop-filter: blur(8px) saturate(120%);
  border-bottom: 1px solid #e1e8ecc0;
}
.cs-head-text {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 1px;
}
.cs-head-text > strong {
  color: var(--cs-strong);
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-head-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--cs-muted);
}
.cs-head-meta > span {
  flex: none;
}
.cs-head-meta > .cs-path {
  flex: 0 1 auto;
  direction: rtl;
  text-align: left;
}
.cs-sep {
  color: #b4c3cc;
}
.cs-head-state.running {
  color: var(--cs-run);
}
.cs-head-state.approval {
  color: var(--cs-wait);
  font-weight: 550;
}
.cs-head-state.failed {
  color: var(--cs-fail);
}
.agent-sessions-app .cs-back {
  display: none;
}
.cs-menu-anchor {
  position: relative;
}
.cs-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 10;
  display: grid;
  min-width: 210px;
  padding: 4px;
  animation: cs-pop 130ms ease-out;
}
@keyframes cs-pop {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
.agent-sessions-app .cs-menu [role="menuitem"] {
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 12.5px;
  text-align: left;
}
.cs-menu [role="menuitem"]:hover,
.cs-menu [role="menuitem"]:focus-visible {
  background: var(--cs-hover);
  outline: none;
}
.cs-menu hr {
  margin: 4px 2px;
  border: 0;
  border-top: 1px solid var(--cs-line);
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
  padding: 66px 20px var(--cs-dock-h, 150px);
  scroll-padding-bottom: var(--cs-dock-h, 150px);
  overflow-wrap: anywhere;
  scrollbar-width: auto;
  scrollbar-color: auto;
}
.cs-timeline {
  max-width: 640px;
  margin: 0 auto;
}
.cs-chat::-webkit-scrollbar-track {
  margin-top: 50px;
  margin-bottom: var(--cs-dock-h, 150px);
}
.cs-thread {
  max-width: 760px;
  margin: 0 auto;
  display: grid;
  gap: 16px;
  padding-bottom: 6px;
}
.cs-older {
  justify-self: center;
}
.cs-message {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.cs-message:hover :deep(.msg-actions) {
  opacity: 1;
}
.cs-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0 4px;
  font-size: 12px;
  color: var(--cs-run);
}
.cs-message-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--cs-muted);
}
.cs-message-meta strong {
  color: var(--cs-strong);
  font-weight: 600;
}
.cs-mark {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: #e3ecf1;
  color: var(--cs-strong);
}
.cs-mark.cs-working :deep(svg) {
  animation: cs-orbit 2.4s linear infinite;
}
@keyframes cs-orbit {
  to {
    transform: rotate(360deg);
  }
}
.cs-user {
  justify-items: end;
}
.cs-user .cs-message-text {
  max-width: min(560px, 86%);
  padding: 8px 12px;
  border-radius: 10px 10px 3px 10px;
  background: #e7eff4;
  color: var(--cs-strong);
}
.cs-message-text {
  min-width: 0;
  max-width: 100%;
  font-size: 13.5px;
  line-height: 1.6;
  color: #3d5262;
}
.cs-trail-state {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 550;
  color: var(--cs-strong);
}
.cs-trail-time {
  flex: none;
  margin-left: auto;
  font-size: 11.5px;
  color: var(--cs-muted);
  font-variant-numeric: tabular-nums;
}
/* Working indicator: dot pairs on rungs pinch shut and reopen, one column
   1/7 of a cycle behind the next, so the pinch travels right like a helix.
   Timing measured from the owner's Pinterest reference. */
.cs-dna {
  position: relative;
  flex: none;
  width: 38px;
  height: 16px;
}
.cs-dna > span {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.6px;
}
.cs-dna i {
  position: absolute;
  left: 0;
  top: 7.2px;
  width: 1.6px;
  height: 1.6px;
  border-radius: 50%;
  background: var(--cs-run);
  transform: translateY(-7px);
  animation: cs-dna-top 1.74s linear infinite;
  animation-delay: inherit;
}
.cs-dna i + i {
  transform: translateY(7px);
  animation-name: cs-dna-bottom;
}
.cs-dna b {
  position: absolute;
  left: 0.5px;
  top: 1px;
  width: 0.6px;
  height: 14px;
  background: var(--cs-run);
  opacity: 0.35;
  animation: cs-dna-rung 1.74s linear infinite;
  animation-delay: inherit;
}
@keyframes cs-dna-top {
  0% {
    transform: translateY(-7px) scale(1);
  }
  8% {
    transform: translateY(-5.6px) scale(1.01);
  }
  10.3% {
    transform: translateY(-3.75px) scale(1.06);
  }
  12.6% {
    transform: translateY(-1.92px) scale(1.15);
  }
  15% {
    transform: translateY(-1.34px) scale(1.18);
  }
  19.5% {
    transform: translateY(-0.95px) scale(1.21);
  }
  24% {
    transform: translateY(-0.63px) scale(1.24);
  }
  26.4% {
    transform: translateY(-0.44px) scale(1.25);
  }
  37% {
    transform: translateY(-0.44px) scale(1.25);
  }
  40% {
    transform: translateY(-0.76px) scale(1.23);
  }
  45% {
    transform: translateY(-1.34px) scale(1.18);
  }
  49% {
    transform: translateY(-2.18px) scale(1.13);
  }
  52% {
    transform: translateY(-3.23px) scale(1.08);
  }
  54% {
    transform: translateY(-4.21px) scale(1.04);
  }
  58.6% {
    transform: translateY(-5.21px) scale(1.02);
  }
  63% {
    transform: translateY(-5.6px) scale(1.01);
  }
  70% {
    transform: translateY(-6.14px) scale(1);
  }
  79% {
    transform: translateY(-6.4px) scale(1);
  }
  93% {
    transform: translateY(-6.73px) scale(1);
  }
  97.7% {
    transform: translateY(-7px) scale(1);
  }
  100% {
    transform: translateY(-7px) scale(1);
  }
}
@keyframes cs-dna-bottom {
  0% {
    transform: translateY(7px) scale(1);
  }
  8% {
    transform: translateY(5.6px) scale(1.01);
  }
  10.3% {
    transform: translateY(3.75px) scale(1.06);
  }
  12.6% {
    transform: translateY(1.92px) scale(1.15);
  }
  15% {
    transform: translateY(1.34px) scale(1.18);
  }
  19.5% {
    transform: translateY(0.95px) scale(1.21);
  }
  24% {
    transform: translateY(0.63px) scale(1.24);
  }
  26.4% {
    transform: translateY(0.44px) scale(1.25);
  }
  37% {
    transform: translateY(0.44px) scale(1.25);
  }
  40% {
    transform: translateY(0.76px) scale(1.23);
  }
  45% {
    transform: translateY(1.34px) scale(1.18);
  }
  49% {
    transform: translateY(2.18px) scale(1.13);
  }
  52% {
    transform: translateY(3.23px) scale(1.08);
  }
  54% {
    transform: translateY(4.21px) scale(1.04);
  }
  58.6% {
    transform: translateY(5.21px) scale(1.02);
  }
  63% {
    transform: translateY(5.6px) scale(1.01);
  }
  70% {
    transform: translateY(6.14px) scale(1);
  }
  79% {
    transform: translateY(6.4px) scale(1);
  }
  93% {
    transform: translateY(6.73px) scale(1);
  }
  97.7% {
    transform: translateY(7px) scale(1);
  }
  100% {
    transform: translateY(7px) scale(1);
  }
}
@keyframes cs-dna-rung {
  0% {
    transform: scaleY(1);
  }
  8% {
    transform: scaleY(0.801);
  }
  10.3% {
    transform: scaleY(0.536);
  }
  12.6% {
    transform: scaleY(0.274);
  }
  15% {
    transform: scaleY(0.191);
  }
  19.5% {
    transform: scaleY(0.136);
  }
  24% {
    transform: scaleY(0.09);
  }
  26.4% {
    transform: scaleY(0.063);
  }
  37% {
    transform: scaleY(0.063);
  }
  40% {
    transform: scaleY(0.109);
  }
  45% {
    transform: scaleY(0.191);
  }
  49% {
    transform: scaleY(0.312);
  }
  52% {
    transform: scaleY(0.461);
  }
  54% {
    transform: scaleY(0.602);
  }
  58.6% {
    transform: scaleY(0.744);
  }
  63% {
    transform: scaleY(0.801);
  }
  70% {
    transform: scaleY(0.877);
  }
  79% {
    transform: scaleY(0.915);
  }
  93% {
    transform: scaleY(0.962);
  }
  97.7% {
    transform: scaleY(1);
  }
  100% {
    transform: scaleY(1);
  }
}
@keyframes cs-fade {
  from {
    opacity: 0;
  }
}
.cs-tool-steps {
  max-width: 75ch;
}
.cs-empty {
  margin: 18px 10px;
  line-height: 1.6;
  color: var(--cs-muted);
  font-size: 12px;
}
.cs-hello {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 70px 0 20px;
  color: var(--cs-muted);
  text-align: center;
  font-size: 12px;
}
.cs-mark-lg {
  width: 40px;
  height: 40px;
  border-radius: 12px;
}
.cs-hello strong {
  color: var(--cs-strong);
  font-size: 15px;
  font-weight: 600;
}
.cs-warning {
  font-size: 12px;
  margin: 0;
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
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  color: var(--cs-muted);
}
.cs-welcome strong {
  color: var(--cs-strong);
  font-weight: 600;
}
.cs-loose {
  display: grid;
  gap: 12px;
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
.cs-compose {
  position: absolute;
  inset: auto 0 0;
  z-index: 4;
  padding: 0 20px 14px;
  pointer-events: none;
}
.cs-picker-anchor {
  position: absolute;
  top: 0;
  left: 20px;
  right: 20px;
  max-width: 760px;
  height: 0;
  margin: 0 auto;
  pointer-events: auto;
}
.cs-skills {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-left: auto;
}
.cs-skills-icon {
  flex: none;
  color: #8296a2;
}
.cs-skill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 7px;
  border: 0;
  border-radius: 6px;
  background: #e6eef3;
  color: #385d76;
  font: 11.5px/1 var(--cs-mono);
  cursor: pointer;
}
.cs-skill:hover:not(:disabled) {
  background: #dae6ed;
}
.cs-skill:focus-visible,
.cs-prompt-name:focus-visible {
  outline: 2px solid #6f8998;
  outline-offset: 1px;
}
.cs-skill-add {
  background: transparent;
  color: #5d7381;
  font-family: inherit;
  font-size: 12px;
}
.cs-skill-add:disabled {
  color: #a9b8c1;
  cursor: default;
}
.cs-prompt-name {
  width: 130px;
  height: 22px;
  padding: 0 7px;
  border: 1px solid #c9d6de;
  border-radius: 6px;
  background: #fbfcfd;
  color: #273f50;
  font: 11.5px/1 var(--cs-mono);
  outline: none;
}
.cs-picker-anchor .context-picker,
.cs-picker-anchor .slash-menu {
  left: 0;
  right: 0;
}
.cs-dock {
  max-width: 760px;
  max-height: 70cqh;
  margin: 0 auto;
  display: grid;
  gap: 8px;
  overflow: auto;
  pointer-events: auto;
}
.cs-card {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid #dbe5eb;
  border-radius: 11px;
  background: #f7f9fae8;
  box-shadow: 0 8px 24px #263f5512;
}
.cs-folder,
.cs-compose-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.cs-folder label {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--cs-muted);
}
.cs-folder label span {
  flex: none;
}
.cs-folder input {
  flex: 1;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--cs-line2);
  border-radius: 7px;
  background: #fbfcfdcc;
  color: inherit;
  font: inherit;
  font-size: 12px;
  outline: 0;
}
.cs-folder input:focus {
  border-color: #7b97a7;
}
.cs-folder-picker {
  display: grid;
  gap: 6px;
}
.cs-folder-picker .cs-grow {
  overflow-wrap: anywhere;
}
.cs-folders {
  display: grid;
  align-content: start;
  gap: 1px;
  max-height: 120px;
  overflow: auto;
}
.agent-sessions-app .cs-folders button {
  justify-content: flex-start;
}
.cs-permission {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid #e6d6b8;
  border-radius: 11px;
  background: #fbf7efe8;
  box-shadow: 0 8px 24px #4a3c2014;
  animation: cs-rise 170ms ease-out;
}
@keyframes cs-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
.cs-perm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--cs-wait);
  font-size: 12.5px;
}
.cs-perm-head strong {
  color: #5e4415;
  font-weight: 600;
}
.cs-perm-head code {
  font-family: var(--cs-mono);
  font-size: 12px;
  padding: 1px 5px;
  border-radius: 4px;
  background: #f0e5d0;
  color: #5e4415;
}
.cs-permission dl {
  margin: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 3px 12px;
  font-size: 12px;
  max-height: 92px;
  overflow: auto;
}
.cs-permission dt {
  color: #8a6c3a;
}
.cs-permission dd {
  margin: 0;
  min-width: 0;
  font-family: var(--cs-mono);
  font-size: 11.5px;
  color: #4b3a1c;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.cs-permission pre {
  margin: 0;
  max-height: 92px;
  overflow: auto;
  padding: 7px 9px;
  border-radius: 6px;
  background: #f3ead9;
  font: 11.5px/1.5 var(--cs-mono);
  color: #4b3a1c;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cs-permission p {
  margin: 0;
  font-size: 12px;
}
.cs-permission .cs-btn {
  border-color: #dfcfae;
}
.cs-permission .cs-ghost {
  border-color: transparent;
}
.cs-permission .cs-btn:hover {
  background: #f1e7d3;
}
.cs-permission .cs-allow {
  color: #3f2f10;
  background: #efe2c4;
  border-color: #d8c294;
}
.cs-permission .cs-allow:hover {
  background: #e9d9b4;
}
.cs-run-error {
  color: #80432c;
  max-height: 100px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
.cs-composer.agent-composer {
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid #dbe5eb;
  border-radius: 14px;
  background: rgb(247 250 252 / 8%);
  backdrop-filter: blur(8px) saturate(120%);
  box-shadow:
    inset 0 1px 3px #53738c12,
    0 10px 28px #263f551a,
    0 2px 6px #263f550f;
}
.cs-composer.agent-composer:focus-within {
  border-color: #7b97a7;
}
.cs-composer.agent-composer > textarea {
  min-height: 44px;
  max-height: 30cqh;
  font-size: 13.5px;
}
.cs-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.cs-small {
  height: 24px;
  padding: 0 6px 0 4px;
}
.cs-attachment {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 220px;
  height: 22px;
  padding-left: 7px;
  border-radius: 5px;
  background: #e6eef3;
  font-size: 11.5px;
}
.cs-attachment span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-sessions-app .cs-attachment button {
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
}
.cs-attachment button:hover {
  background: #d6e3ea;
}
.cs-compose-actions :deep(.select-trigger.cs-model) {
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  max-width: 200px;
  height: 28px;
  padding: 0 7px 0 8px;
  gap: 6px;
  border: 1px solid var(--cs-line2);
  border-radius: 7px;
  background: #fbfcfd99;
  font-size: 12px;
}
.cs-compose-actions :deep(.select-trigger.cs-model:hover),
.cs-compose-actions :deep(.select-trigger.cs-model[aria-expanded="true"]) {
  background: var(--cs-hover);
}
.cs-compose-actions :deep(.select-trigger.cs-model[aria-expanded="true"]) {
  border-color: #7b97a7;
}
.cs-folder-chip {
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 180px;
  height: 28px;
  padding: 0 4px;
  font-size: 12px;
  color: var(--cs-muted);
}
.cs-folder-chip span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-status {
  flex: 1 1 auto;
  min-width: 52px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--cs-muted);
  text-align: right;
}
.cs-status.cs-running {
  color: var(--cs-run);
}
.cs-send {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
}
.cs-stop {
  flex: none;
  height: 30px;
}
@container (max-width: 650px) {
  .cs-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .cs-has-selection .cs-sidebar {
    display: none;
  }
  .cs-sidebar {
    border-right: 0;
  }
  .cs-welcome {
    display: none;
  }
  .agent-sessions-app .cs-back {
    display: inline-flex;
  }
  .cs-session-header {
    padding-left: 8px;
  }
  .cs-open-folder span {
    display: none;
  }
  .agent-sessions-app .cs-open-folder {
    width: 28px;
    padding: 0;
  }
  .cs-chat {
    padding-left: 12px;
    padding-right: 12px;
  }
  .cs-compose {
    padding: 0 10px 10px;
  }
  .cs-compose-actions :deep(.select-trigger.cs-model) {
    max-width: 140px;
  }
  .cs-folder-chip {
    display: none;
  }
}
@container (max-width: 440px) {
  .cs-composer .cs-compose-actions {
    flex-wrap: wrap;
  }
  .cs-status {
    order: 5;
    flex-basis: 100%;
    text-align: left;
  }
  .cs-stop,
  .cs-send {
    margin-left: auto;
  }
  .cs-user .cs-message-text {
    max-width: 94%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-sessions-app *,
  .agent-sessions-app *::before,
  .agent-sessions-app *::after {
    animation: none !important;
    transition: none !important;
  }
}
</style>
