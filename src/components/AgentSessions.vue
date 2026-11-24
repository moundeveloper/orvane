<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import {
  AGENT_REVEAL,
  agentLineage,
  agentOpenRequests,
  agentRunIndicators,
  continueDrafts,
  pendingReveals,
  PIN_AGENT_DRAFT,
  recordLineage,
  revealSession,
  type AgentDraft,
  type AgentReveal,
  type AgentSource,
} from "../agentNavigation";
import ContinuePicker, { type ContinueChoice } from "./ContinuePicker.vue";
import ContinueCard from "./ContinueCard.vue";
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
import AgentQuestions from "./AgentQuestions.vue";
import ImagePeek, { type PeekImage } from "./ImagePeek.vue";
import ThinkingTrail from "./ThinkingTrail.vue";
import DnaHelix from "./DnaHelix.vue";
import AgentSettings from "./AgentSettings.vue";
import AgentUsage from "./AgentUsage.vue";
import CustomSelect from "./CustomSelect.vue";
import ContextPicker from "./ContextPicker.vue";
import ComposerModes from "./ComposerModes.vue";
import FilesChanged from "./FilesChanged.vue";
import ContextRing from "./ContextRing.vue";
import ScheduledPrompts from "./ScheduledPrompts.vue";
import AgentTiles from "./AgentTiles.vue";
import ActivityBell from "./AgentActivity.vue";
import KeepAwake from "./KeepAwake.vue";
import SnapshotPicker from "./SnapshotPicker.vue";
import RewindCard, { type RewindMode, type SessionCheckpoint } from "./RewindCard.vue";
import type { MentionSession } from "./ContextPicker.vue";
import {
  harness,
  markSeen,
  quoteText,
  registerComposer,
  snapshotApp,
  touchComposer,
  type AgentQuote,
  type ComposerHandle,
} from "../agentHarness";
import {
  HOST,
  leaf,
  leaves,
  readTiles,
  replaceLeaf,
  split as splitTiles,
  tileId,
  type PaneSession,
  type TileNode,
  type TilesState,
} from "../agentTiles";
import MessageActions, { type MessageAction } from "./MessageActions.vue";
import { sendToNotes } from "../agentMessageNotes";
import SlashMenu, { type SlashEntry } from "./SlashMenu.vue";
import SessionTimeline, { type SessionApproval } from "./SessionTimeline.vue";
import { registerCommands } from "../commands";
import {
  agentBusy,
  agentNames,
  askedQuestions,
  attachmentPicture,
  splitAttachments,
  summarizeAgentRun,
  type AgentRunSummary,
  type AgentProvider,
  type AgentRun,
  type AgentActivity,
  type AgentContext,
  type AgentEditMode,
  type AgentEffort,
  type AgentQueued,
  type AgentSchedule,
} from "../agentSessions";
import {
  api as fileRequest,
  DRAG_MIME,
  fileToken,
  parentOf,
  rawUrl,
  type FileEntry,
  type Roots,
} from "./files/explorer";
// `pane` runs this app as one split pane of another Agent Sessions app: only
// the session view, no toolbar or session list. The host keeps the layout.
const props = defineProps<{
  block: Block;
  /** quiet: opening a session leaves focus where it is (AI launcher preview). */
  pane?: PaneSession & { id: string; nonce: number; quiet?: boolean; initialDraft?: AgentDraft };
  focused?: boolean;
}>();
const emit = defineEmits<{
  "pane-state": [state: PaneSession];
  "draft-state": [draft: AgentDraft];
  /** A split pane asks the host to open a continued draft beside it. */
  continue: [draft: AgentDraft];
}>();
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
// Context use read from the transcript; a working Claude run streams fresher numbers.
const sessionContext = ref<AgentContext | null>(null);
const contextNow = computed(() =>
  (agentBusy(run.value) && run.value?.context) || sessionContext.value || run.value?.context || null,
);
const sending = ref(false);
const runError = ref("");
const live = ref(false);
const browsing = ref(false);
const browsePath = ref("");
const folders = ref<FileEntry[]>([]);
const sessionView = ref<HTMLElement>();
const dock = ref<HTMLFormElement>();
const paths = ref<string[]>([]);
// Selections, app snapshots and mentioned sessions sent with the next message.
// They stay when another session is opened, until sent or removed.
const quotes = ref<AgentQuote[]>([]);
const hasDraft = computed(() => !!draft.value.trim() || quotes.value.length > 0);
const dropping = ref(false);
const snapshotOpen = ref(false);
const snapshotBusy = ref(false);
// Suggested next message after a turn ends: the placeholder, Tab takes it.
const suggestion = ref("");
// Checkpoints taken before each turn, and the one being rewound to.
const checkpoints = ref<SessionCheckpoint[]>([]);
const rewinding = ref<SessionCheckpoint | null>(null);
const rewindBusy = ref(false);
// After "Restore chat": the next message continues from this transcript entry.
const rewindAt = ref<{ resumeAt: string; message: string } | null>(null);
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
const tilePopover = ref<{ key?: string; x: number; y: number }>();
const tilePopup = ref<HTMLElement>();
const tileAlreadyOpen = computed(() => !!tilePopover.value?.key && !!findOpenPane(tilePopover.value.key));
let tileTrigger: HTMLElement | undefined;
const tileShortcuts = [
  ["Open session in a new pane", "Ctrl+click"],
  ["Split the focused pane", "Alt+Shift+D"],
  ["Split right", "Alt+Shift+="],
  ["Split down", "Alt+Shift+-"],
  ["Focus another pane", "Alt+Arrow"],
  ["Swap panes", "Alt+Shift+Arrow"],
  ["Close the focused pane", "Ctrl+Shift+W"],
];
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
const tiles = ref<TilesState>({ root: leaf(HOST), focus: HOST, panes: {} });
// Bumped when the host tells a pane to open something.
const paneNonces = ref<Record<string, number>>({});
const tileView = ref<InstanceType<typeof AgentTiles>>();
const paneRoot: TileNode = leaf(HOST);
if (props.pane) {
  active.value = props.pane.key || "";
  if (!props.pane.key && props.pane.provider) {
    newProvider.value = props.pane.provider;
    folder.value = props.pane.folder || "";
  }
} else {
  try {
    const saved = JSON.parse(props.block.value || "{}");
    active.value = saved.active || "";
    const restored = readTiles(saved.tiles);
    if (restored) tiles.value = restored;
  } catch {}
}
const selected = computed(() =>
  sessions.value.find((s) => s.key === active.value),
);
const provider = computed(
  () => newProvider.value || selected.value?.provider || "claude",
);
const busy = computed(() => sending.value || agentBusy(run.value));
const usagePill = ref<InstanceType<typeof AgentUsage>>();
// A finished run may have reported new subscription limits.
watch(busy, (now, before) => {
  if (before && !now) void usagePill.value?.refresh();
});
const queuePending = ref(false);
const schedules = ref<AgentSchedule[]>([]);
const schedulesOpen = ref(false);
const settingsOpen = ref(false);
const settingsButton = ref<HTMLButtonElement>();
const settingsPane = ref<InstanceType<typeof AgentSettings>>();
const schedulesLoading = ref(false);
const schedulesPane = ref<InstanceType<typeof ScheduledPrompts>>();
const contextRing = ref<InstanceType<typeof ContextRing>>();
const scheduleButton = ref<HTMLButtonElement>();
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
// A chat without its own pick uses the default from Settings → Sessions.
const editMode = computed({
  get: () => chosenModes.value[modelKey.value] ?? harness.settings.defaultModes?.[provider.value] ?? "",
  set: (value: AgentEditMode | "") => {
    chosenModes.value = { ...chosenModes.value, [modelKey.value]: value };
  },
});
function modelOptionsFor(kind: AgentProvider) {
  const listed = modelCatalogues.value[kind];
  const options = listed?.length
    ? listed
    : kind === "claude"
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
}
const modelOptions = computed(() => modelOptionsFor(provider.value));
const loadingModels = new Set<AgentProvider>();
async function loadModels(kind: AgentProvider) {
  if (modelCatalogues.value[kind] || loadingModels.has(kind)) return;
  loadingModels.add(kind);
  try {
    const { models } = await agentRequest<{ models: { value: string; label: string }[] }>("models", { provider: kind });
    modelCatalogues.value = { ...modelCatalogues.value, [kind]: models };
  } catch {
    // Keep the built-in defaults available if catalogue loading fails.
  } finally {
    loadingModels.delete(kind);
  }
}
watch(provider, loadModels, { immediate: true });
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
    { label: "Needs attention", items: nest(attention), runs: pendingRuns.value },
    { label: "Today", items: nest(today), runs: [] },
    { label: "Earlier", items: nest(earlier), runs: [] },
  ].filter((group) => group.items.length || group.runs.length);
});
// A continued session sits right under the session it came from, indented,
// when both are in the same group.
function nest(items: AgentSession[]) {
  const keys = new Set(items.map((s) => s.key));
  const children = new Map<string, AgentSession[]>();
  const top: AgentSession[] = [];
  for (const s of items) {
    const parent = agentLineage.get(s.key)?.key;
    if (parent && parent !== s.key && keys.has(parent)) children.set(parent, [...(children.get(parent) ?? []), s]);
    else top.push(s);
  }
  const out: AgentSession[] = [];
  const seen = new Set<string>();
  const add = (s: AgentSession) => {
    if (seen.has(s.key)) return;
    seen.add(s.key);
    out.push(s);
    for (const child of children.get(s.key) ?? []) add(child);
  };
  top.forEach(add);
  items.forEach(add);
  return out;
}
const childKeys = computed(() => {
  const out = new Set<string>();
  for (const group of groups.value) {
    const keys = new Set(group.items.map((s) => s.key));
    for (const s of group.items) {
      const parent = agentLineage.get(s.key)?.key;
      if (parent && parent !== s.key && keys.has(parent)) out.add(s.key);
    }
  }
  return out;
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
// Once a finished run's turn is in the transcript, its calls fold into a time
// strip at the top of that reply (not a block under it). -2: the reply already
// lists its own tool calls; -1: no reply to put them on, keep them apart.
const runStripAt = computed(() => {
  if (live.value || working.value || !run.value?.activities?.length) return -1;
  let reply = -1;
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const message = messages.value[i]!;
    if (message.role === "user") break;
    if (message.tools.length) return -2;
    if (message.text) reply = i;
  }
  return reply;
});
// Head of the thinking trail: what the run is doing as a whole.
const trailLabel = computed(() => {
  if (!run.value) return "";
  if (run.value.permissions.length)
    return askedQuestions(run.value.permissions[0]!) ? "Waiting for your answers" : "Waiting for your approval";
  if (run.value.status === "stopping") return "Stopping…";
  // A tool step is running: the steps below say which. Text written before
  // a tool call ("I'll check…") is not the answer yet.
  if (run.value.activities?.some((step) => step.status === "running")) return "Working";
  return run.value.text ? "Replying" : "Thinking";
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
  if (provider.value !== "claude" || !selected.value || busy.value) return;
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
  if (event.ctrlKey && event.altKey && !event.shiftKey && (event.code === "KeyS" || event.code === "KeyZ")) {
    event.preventDefault();
    if (event.code === "KeyS") openSnapshot();
    else rewindLatest();
    return;
  }
  if (suggestion.value && !draft.value && !mention.value && !slash.value) {
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      draft.value = suggestion.value;
      suggestion.value = "";
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      suggestion.value = "";
      return;
    }
  }
  if (event.altKey && event.key === "ArrowUp") {
    const last = run.value?.queued?.at(-1);
    if (last) {
      event.preventDefault();
      void editQueued(last);
      return;
    }
  }
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
  // Ctrl+Alt+M continue with another model, Ctrl+Alt+O open the source. A
  // split pane answers first; its host then leaves the key alone.
  if (
    event.ctrlKey && event.altKey && !event.shiftKey && !event.metaKey &&
    (event.code === "KeyM" || event.code === "KeyO") && !event.defaultPrevented
  ) {
    if (event.code === "KeyM" && (selected.value || sourceQuote.value)) {
      event.preventDefault();
      openContinue();
    } else if (event.code === "KeyO" && fromSource.value) {
      event.preventDefault();
      openSource();
    }
    // Inside a split pane the key belongs to this pane, never to the host's.
    if (props.pane) event.preventDefault();
    return;
  }
  if (
    props.pane ||
    schedulesOpen.value || event.key !== "/" ||
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
function menuKey(event: KeyboardEvent, close = closeMenu) {
  const items = [
    ...((event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[role=menuitem]")),
  ];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close(true);
  } else if (event.key === "Tab") close();
}
async function showTilePopover(event: MouseEvent, key?: string) {
  if (!key && tilePopover.value && !tilePopover.value.key) {
    closeTilePopover();
    return;
  }
  const app = root.value;
  if (!app) return;
  tileTrigger = event.currentTarget as HTMLElement;
  const bounds = app.getBoundingClientRect();
  const trigger = tileTrigger.getBoundingClientRect();
  const scale = bounds.width / app.offsetWidth || 1;
  const atPointer = key && (event.clientX || event.clientY);
  const popup = {
    key,
    x: ((atPointer ? event.clientX : trigger.left) - bounds.left) / scale,
    y: ((atPointer ? event.clientY : trigger.bottom) - bounds.top) / scale + 4,
  };
  tilePopover.value = popup;
  await nextTick();
  const element = tilePopup.value;
  if (!element) return;
  tilePopover.value = {
    ...popup,
    x: Math.max(4, Math.min(popup.x, app.clientWidth - element.offsetWidth - 4)),
    y: Math.max(4, Math.min(popup.y, app.clientHeight - element.offsetHeight - 4)),
  };
  (element.querySelector<HTMLButtonElement>("[role=menuitem]") ?? element).focus({ preventScroll: true });
}
function closeTilePopover(restore = false) {
  tilePopover.value = undefined;
  if (restore) tileTrigger?.focus({ preventScroll: true });
  tileTrigger = undefined;
}
function tileSession(dir: "row" | "column" | "auto") {
  const key = tilePopover.value?.key;
  closeTilePopover();
  if (key) splitPane(dir, { key });
}
function outsideMenu(event: Event) {
  if (tilePopover.value) {
    const path = event.composedPath();
    if (![tilePopup.value, tileTrigger].some((el) => el && path.includes(el))) closeTilePopover();
  }
  if (continueOpen.value) {
    const path = event.composedPath();
    const inside = [continueMenu.value?.$el as HTMLElement | undefined, menuButton.value, continuePill.value]
      .some((el) => el && path.includes(el));
    if (!inside) continueOpen.value = "";
  }
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
async function menuAction(action: "folder" | "id" | "resume" | "reload" | "timeline" | "suggest") {
  closeMenu(action !== "timeline");
  try {
    if (action === "suggest") toggleSuggest();
    else if (action === "timeline") await openTimeline();
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
  sessionContext.value = null;
  runError.value = "";
  draft.value = "";
  sending.value = false;
  live.value = false;
  browsing.value = false;
  paths.value = [];
  mention.value = null;
  rawPermissions.value = new Set();
  menuOpen.value = false;
  suggestion.value = "";
  snapshotOpen.value = false;
  rewinding.value = null;
  rewindAt.value = null;
  checkpoints.value = [];
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

function currentDraft(kind: AgentProvider): AgentDraft {
  return { provider: kind, folder: folder.value, text: draft.value, paths: paths.value,
    quotes: quotes.value, model: model.value, effort: effort.value, mode: editMode.value,
    runId: run.value?.id };
}
function pinNew() {
  if (!newProvider.value || sending.value) return;
  window.dispatchEvent(new CustomEvent<AgentDraft>(PIN_AGENT_DRAFT, { detail: currentDraft(newProvider.value) }));
  if (!busy.value) clearSent();
}

async function loadPinnedDraft(value: AgentDraft) {
  back();
  newProvider.value = value.provider;
  folder.value = value.folder;
  draft.value = value.text;
  paths.value = value.paths;
  quotes.value = value.quotes ?? [];
  const origin = quotes.value.find((quote) => quote.origin);
  continuing.value = origin?.origin
    ? { key: origin.origin.key, title: origin.source, provider: origin.origin.provider }
    : null;
  if (value.model !== undefined) model.value = value.model;
  if (value.effort !== undefined) effort.value = value.effort;
  if (value.mode !== undefined) editMode.value = value.mode;
  if (value.runId) {
    const ticket = revision;
    const restored = await agentRequest<AgentRun | null>("inspect-run", { id: value.runId }).catch(() => null);
    if (restored && ticket === revision) watchRun(restored);
  }
}

/* ---------- Continue with another model (UI Maker r3) ---------- */
// The session menu turns into a model list; the pick opens a draft beside
// this chat (split pane) or in the pinned panel. The draft carries the source
// as a session quote with its transcript path, and both sessions link to
// each other.
/** The source of the draft shown here, until it is sent and becomes a session. */
const continuing = ref<AgentSource | null>(null);
const continueOpen = ref<"" | "menu" | "pill">("");
const continueMenu = ref<InstanceType<typeof ContinuePicker>>();
const continuePill = ref<HTMLElement>();
const continueOptions = computed(() => ({ claude: modelOptionsFor("claude"), codex: modelOptionsFor("codex") }));
const continuePlace = computed(() => (props.pane?.id === "side" ? "panel" : "beside"));
const sourceQuote = computed(() => (newProvider.value ? quotes.value.find((quote) => quote.origin) : undefined));
/** Header link: where this session came from. */
const fromSource = computed<AgentSource | null>(() =>
  newProvider.value ? continuing.value : (active.value && agentLineage.get(active.value)) || null,
);
/** Header link on the source: the newest session or draft that continues it. */
const continuedIn = computed(() => {
  const key = active.value;
  if (!key || newProvider.value) return null;
  const draft = [...continueDrafts.values()].reverse().find((item) => item.from.key === key && item.blockId === props.block.id);
  if (draft) return { label: `New ${agentNames[draft.provider]} session`, go: () => revealSession({ blockId: props.block.id, paneId: draft.paneId }) };
  const child = [...agentLineage].reverse().find(([, source]) => source.key === key)?.[0];
  if (!child) return null;
  const title = sessions.value.find((s) => s.key === child)?.title || "the next session";
  return { label: title, go: () => revealSession({ blockId: props.block.id, key: child }) };
});
const continueId = tileId("draft");
watch(
  [continuing, newProvider],
  ([source, kind]) => {
    if (source && kind)
      continueDrafts.set(continueId, { id: continueId, blockId: props.block.id, paneId: props.pane?.id ?? HOST, from: source, provider: kind });
    else continueDrafts.delete(continueId);
  },
  { immediate: true },
);
onBeforeUnmount(() => continueDrafts.delete(continueId));

function openContinue() {
  if (!selected.value && !sourceQuote.value) return;
  menuOpen.value = false;
  void loadModels("claude");
  void loadModels("codex");
  continueOpen.value = selected.value ? "menu" : "pill";
}
function closeContinue(restore = false) {
  const was = continueOpen.value;
  continueOpen.value = "";
  if (!restore) return;
  if (was === "menu") menuButton.value?.focus({ preventScroll: true });
  else continuePill.value?.focus({ preventScroll: true });
}
const firstLine = (text: string, limit = 140) =>
  (text.split(/\r?\n/).map((line) => line.replace(/^[#>*\-\s`]+/, "").trim()).find(Boolean) ?? "").slice(0, limit);
const oneLine = (text: string, limit: number) => {
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
};
async function buildContinueDraft(choice: ContinueChoice): Promise<AgentDraft | null> {
  const s = selected.value;
  if (!s) return null;
  const kind = s.provider ?? "claude";
  let transcript = "";
  try {
    transcript = (await agentRequest<{ path: string }>("transcript-file", { key: s.key })).path;
  } catch (cause) {
    showRunError(cause);
    return null;
  }
  const list = messages.value;
  const said = (m: AgentMessage) => (m.role === "user" ? userParts(m.text).text : m.text).trim();
  const lastIndex = (test: (m: AgentMessage) => boolean) => {
    for (let i = list.length - 1; i >= 0; i--) if (test(list[i]!)) return i;
    return -1;
  };
  const lastUser = lastIndex((m) => m.role === "user" && !!said(m));
  const lastReply = lastIndex((m) => m.role !== "user" && !!said(m));
  const changed = [
    ...new Set(
      list.flatMap((m) =>
        m.tools
          .filter((tool) => /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|edit|write|str_replace)/i.test(tool.name))
          .map((tool) => tool.input?.file_path || tool.input?.path || tool.input?.notebook_path || "")
          .filter(Boolean),
      ),
    ),
  ].slice(-6);
  const replyText = lastReply >= 0 ? said(list[lastReply]!) : "";
  // The agent spoke last and ended on a question: that is what is open.
  const question =
    lastReply > lastUser
      ? replyText.split(/\n\s*\n/).map((part) => part.trim()).reverse().find((part) => /\?\s*$/.test(part)) ?? ""
      : "";
  const origin = {
    key: s.key,
    provider: kind,
    transcript,
    ...(model.value ? { model: modelOptionsFor(kind).find((option) => option.value === model.value)?.label ?? model.value } : {}),
    updatedAt: s.updatedAt,
    calls: list.reduce((sum, m) => sum + m.tools.length, 0),
    asked: lastUser >= 0 ? oneLine(said(list[lastUser]!), 200) : "",
    reply: oneLine(replyText, 260),
    changed,
    open: oneLine(question, 220),
    turns: list
      .filter((m) => said(m) || m.tools.length)
      .slice(-60)
      .map((m) => ({ id: m.id, at: m.at, role: m.role, line: firstLine(said(m)) || `${m.tools.length} tool calls`, tools: m.tools.length })),
  };
  const summary = [
    origin.asked && `Asked: ${origin.asked}`,
    origin.reply && `Last reply: ${origin.reply}`,
    changed.length && `Changed: ${changed.join(", ")}`,
    origin.open && `Open: ${origin.open}`,
  ].filter(Boolean).join("\n");
  return {
    provider: choice.provider,
    folder: s.project,
    text: `Continue from "${s.title}". `,
    paths: [],
    quotes: [{
      id: `continue:${s.key}`,
      kind: "session",
      source: s.title,
      detail: `${agentNames[kind]} in ${projectName(s.project)}, session ${s.sessionId}`,
      text: summary,
      origin,
    }],
    model: choice.model,
  };
}
async function pickContinue(choice: ContinueChoice) {
  const mode = continueOpen.value;
  continueOpen.value = "";
  if (mode === "pill") {
    // The draft's destination changes; nothing else does.
    newProvider.value = choice.provider;
    model.value = choice.model;
    focusComposerEnd();
    return;
  }
  const draftValue = await buildContinueDraft(choice);
  if (!draftValue) return;
  if (props.pane?.id === "side") window.dispatchEvent(new CustomEvent<AgentDraft>(PIN_AGENT_DRAFT, { detail: draftValue }));
  else if (props.pane) emit("continue", draftValue);
  else continueBeside(HOST, draftValue);
}
/** The host opens a continued draft as a new tile beside `from`. */
function continueBeside(from: string, value: AgentDraft) {
  tiles.value.focus = from;
  splitPane("row", { provider: value.provider, folder: value.folder, initialDraft: value });
}
async function focusComposerEnd() {
  await nextTick();
  const field = composer.value;
  if (!field) return;
  field.focus({ preventScroll: true });
  field.setSelectionRange(field.value.length, field.value.length);
}
function openSource(messageId?: string) {
  const source = sourceQuote.value?.origin?.key ?? fromSource.value?.key;
  if (source) revealSession({ blockId: props.block.id, key: source, messageId });
}
/** Scroll a message into view and mark it for a moment. */
async function revealMessage(id: string) {
  await nextTick();
  const element = thread.value?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
  if (!element) return;
  pinned = false;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.classList.remove("cs-flash");
  void element.offsetWidth;
  element.classList.add("cs-flash");
  setTimeout(() => element.classList.remove("cs-flash"), 1300);
}
function onReveal(event: Event) {
  const detail = (event as CustomEvent<AgentReveal>).detail;
  if (detail.blockId !== props.block.id) return;
  // The host brings the pane forward, or opens the session beside.
  if (!props.pane) {
    const ids = leaves(tiles.value.root);
    const at = detail.paneId
      ? ids.includes(detail.paneId) ? detail.paneId : ""
      : active.value === detail.key && ids.includes(HOST)
        ? HOST
        : Object.keys(tiles.value.panes).find((id) => tiles.value.panes[id]!.key === detail.key) ?? "";
    if (at) tiles.value.focus = at;
    else if (detail.key) splitPane("row", { key: detail.key });
  }
  if (detail.key && detail.key === active.value && messages.value.length) {
    const id = pendingReveals.get(detail.key);
    pendingReveals.delete(detail.key);
    if (id) void revealMessage(id);
  }
}
onMounted(() => window.addEventListener(AGENT_REVEAL, onReveal));
onBeforeUnmount(() => window.removeEventListener(AGENT_REVEAL, onReveal));

async function focusComposer() {
  schedulesOpen.value = false;
  settingsOpen.value = false;
  if (expanded.value) await collapse();
  await nextTick();
  if (selected.value || newProvider.value) composer.value?.focus();
  else searchInput.value?.focus();
}

async function present(value: AgentRun) {
  const ticket = revision;
  if (agentBusy(value) && !runStarts.has(value.id))
    runStarts.set(value.id, Date.now());
  recordIndicator(summarizeAgentRun(value));
  if (value.next) {
    const next = await agentRequest<AgentRun | null>("inspect-run", { id: value.next }).catch(() => null);
    if (ticket !== revision) return;
    if (next) {
      if (active.value) await read();
      if (ticket === revision) watchRun(next);
      return;
    }
  }
  run.value = value;
  if (value.context) sessionContext.value = value.context;
  if (!agentBusy(value)) markSeen(value.id);
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
        // The mode picked for the new chat stays with the session it became.
        const picked = chosenModes.value[`new:${value.provider}`];
        if (picked !== undefined) chosenModes.value = { ...chosenModes.value, [session.key]: picked };
        if (model.value) chosenModels.value = { ...chosenModels.value, [session.key]: model.value };
        if (effort.value) chosenEfforts.value = { ...chosenEfforts.value, [session.key]: effort.value };
        const waitingDraft = draft.value;
        const waitingPaths = paths.value;
        const scrolled = chat.value?.scrollTop ?? 0;
        if (continuing.value) recordLineage(session.key, continuing.value);
        await select(session.key, true);
        if (!pinned && chat.value) {
          await nextTick();
          chat.value.scrollTop = scrolled;
        }
        if (active.value === session.key && !draft.value) {
          draft.value = waitingDraft;
          paths.value = waitingPaths;
        }
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
  if (live.value && pinned && chat.value && ticket === revision)
    chat.value.scrollTop = chat.value.scrollHeight;
}

function watchRun(value: AgentRun) {
  live.value = true;
  closeStream();
  void present(value).catch(showRunError);
  if (agentBusy(value)) syncStream();
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

function withAttachments(text: string, files: string[]) {
  return files.length
    ? `${text}\n\nLocal attachments:\n${files.map((path) => JSON.stringify(path)).join("\n")}`
    : text;
}
// The draft as sent: the text, then the attached paths.
function outgoing() {
  const files = [
    ...new Set([...paths.value, ...quotes.value.flatMap((quote) => (quote.image ? [quote.image] : []))]),
  ];
  const context = quotes.value.map(quoteText).join("\n\n");
  const text = context ? (draft.value.trim() ? `${draft.value}\n\n${context}` : context) : draft.value;
  return withAttachments(text, files);
}
function clearSent() {
  draft.value = "";
  paths.value = [];
  quotes.value = [];
  mention.value = null;
}
// While a run works, a message waits in its queue (first: interrupt and send
// it next; "steer": Claude takes it between tool calls of the working turn).
async function queueDraft(first: boolean | "steer" = false) {
  const value = run.value;
  if (!value || value.status !== "running" || !hasDraft.value || queuePending.value) return;
  const ticket = revision;
  const message = outgoing();
  queuePending.value = true;
  runError.value = "";
  try {
    const updated = await agentRequest<(AgentRun & { steerError?: string }) | null>("queue", {
      id: value.id,
      message,
      ...(first === "steer" ? { steer: true } : first ? { first: true } : {}),
    });
    if (ticket !== revision) return;
    if (outgoing() === message) clearSent();
    if (updated && run.value?.id === updated.id) {
      run.value.queued = updated.queued;
      run.value.steered = updated.steered;
    }
    if (updated?.steerError) showNotice(`Queued instead: ${updated.steerError}`);
  } catch (error) {
    if (ticket === revision) showRunError(error);
  } finally {
    queuePending.value = false;
  }
}
async function queueCommand(operation: "unqueue" | "queue-now" | "steer", item: AgentQueued) {
  const value = run.value;
  if (!value || queuePending.value) return false;
  const ticket = revision;
  queuePending.value = true;
  try {
    const updated = await agentRequest<AgentRun>(operation, { id: value.id, queueId: item.id });
    if (ticket !== revision) return false;
    if (updated.id !== value.id) {
      // A run that had ended started the message itself.
      if (run.value) run.value.queued = [];
      watchRun(updated);
    } else if (run.value?.id === updated.id) {
      run.value.queued = updated.queued;
      run.value.steered = updated.steered;
    }
    return true;
  } catch (error) {
    if (ticket === revision) showRunError(error);
    return false;
  } finally {
    queuePending.value = false;
  }
}
// Edit takes the message back into the composer.
async function editQueued(item: AgentQueued) {
  if (!(await queueCommand("unqueue", item))) return;
  draft.value = draft.value.trim() ? `${draft.value}\n${item.text}` : item.text;
  await nextTick();
  composer.value?.focus({ preventScroll: true });
}
const queueLine = (text: string) => text.trim().split(/\r?\n/, 1)[0]!.slice(0, 240);
async function send(messageOverride?: string) {
  if (agentBusy(run.value) && !sending.value) return queueDraft();
  // Sending brings the view back to the end of the conversation.
  pinned = true;
  if (
    busy.value ||
    !(messageOverride || hasDraft.value) ||
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
    const message = messageOverride ?? outgoing();
    const chosen = {
      ...(model.value ? { model: model.value } : {}),
      ...(effort.value ? { effort: effort.value } : {}),
      ...(editMode.value ? { mode: editMode.value } : {}),
      ...(!messageOverride && forking.value && !newProvider.value ? { fork: true } : {}),
      ...(!messageOverride && rewindAt.value && !newProvider.value ? { resumeAt: rewindAt.value.resumeAt } : {}),
    };
    const result = await agentRequest<AgentRun>("start", {
      message,
      target: newProvider.value
        ? { provider: newProvider.value, folder: folder.value.trim(), ...chosen }
        : { key: active.value, ...chosen },
    });
    if (ticket !== revision) return;
    if (!messageOverride) {
      clearSent();
      forking.value = false;
      rewindAt.value = null;
    }
    closeBrowser();
    watchRun(result);
  } catch (error) {
    if (ticket === revision) showRunError(error);
  } finally {
    if (ticket === revision) sending.value = false;
  }
}

// While a Claude turn works, Ctrl+Enter steers it and Ctrl+Shift+Enter stops
// it and sends next. Codex reads its message once, so Ctrl+Enter interrupts.
function onEnter(event: KeyboardEvent) {
  if (event.isComposing) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const running = run.value?.status === "running";
  if (event.shiftKey && !(ctrl && running)) return;
  event.preventDefault();
  if (ctrl && running) {
    void queueDraft(run.value!.provider === "claude" && !event.shiftKey ? "steer" : true);
    return;
  }
  void send();
}
/* ---------- context from other apps, sessions and files ---------- */
const composerHandle: ComposerHandle = {
  element: () => root.value,
  addQuote(quote) {
    quotes.value = [...quotes.value.filter((item) => item.id !== quote.id), quote].slice(-8);
    void focusComposer();
  },
};
const quoteLine = (quote: AgentQuote) =>
  (quote.origin &&
    `full transcript · ${quote.origin.turns.length} turns · ${quote.origin.calls} tool ${quote.origin.calls === 1 ? "call" : "calls"}`) ||
  quote.text.trim().split(/\r?\n/).find((line) => line.trim())?.slice(0, 160) ||
  (quote.image ? "Picture" : "");
function removeQuote(id: string) {
  quotes.value = quotes.value.filter((quote) => quote.id !== id);
}
// Files dragged from Orvane's File Explorer, or from Windows, become chips.
function draggingFiles(event: DragEvent) {
  const types = event.dataTransfer?.types ?? [];
  return types.includes(DRAG_MIME) || types.includes("Files");
}
function dragOver(event: DragEvent) {
  if (!draggingFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer!.dropEffect = "copy";
  dropping.value = true;
}
function dragLeave(event: DragEvent) {
  if (!dock.value?.contains(event.relatedTarget as Node | null)) dropping.value = false;
}
function dropFiles(event: DragEvent) {
  dropping.value = false;
  const data = event.dataTransfer;
  if (!data || !draggingFiles(event)) return;
  event.preventDefault();
  event.stopPropagation();
  let dropped: string[] = [];
  try {
    const parsed = data.types.includes(DRAG_MIME) ? JSON.parse(data.getData(DRAG_MIME)) : null;
    if (Array.isArray(parsed?.paths)) dropped = parsed.paths.filter((path: unknown) => typeof path === "string");
  } catch {
    /* Drag data from somewhere else. */
  }
  if (!dropped.length) {
    const desktop = (window as unknown as { orvaneDesktop?: { pathForFile?(file: File): string } }).orvaneDesktop;
    dropped = [...data.files].map((file) => desktop?.pathForFile?.(file) ?? "").filter(Boolean);
  }
  if (!dropped.length) return;
  paths.value = [...new Set([...paths.value, ...dropped])].slice(0, 20);
  void focusComposer();
}
// Pasted pictures show as tiles in the composer and above the sent message;
// a click opens them full-window (ImagePeek), ← → step through the set.
const pictures = (list: string[]) =>
  list.flatMap((path) => {
    const src = attachmentPicture(path);
    return src ? [{ path, src }] : [];
  });
const draftPictures = computed(() => pictures(paths.value));
const draftFiles = computed(() => paths.value.filter((path) => !attachmentPicture(path)));
/** Show pictures as tiles and keep other attachments in the message. */
// The source reference of a continued session (quoteText's origin block),
// shown as a small chip under the message instead of its full text.
const continuedBlock =
  /\n*Continue from the earlier session "(.*?)"(?: \([^\n]*\))?\.\nIts full transcript \(JSONL\) is at: [^\n]*\nRead it when [^\n]*\n```\n[\s\S]*?\n```\s*$/;
function userParts(text: string) {
  const { text: body, paths: sent } = splitAttachments(text);
  const tiles = pictures(sent);
  const imagePaths = new Set(tiles.map((picture) => picture.path));
  const reference = continuedBlock.exec(body);
  const shown = reference ? body.slice(0, reference.index) : body;
  const others = sent.filter((path) => !imagePaths.has(path));
  return {
    text: tiles.length || reference ? withAttachments(shown, tiles.length ? others : sent) : text,
    pictures: tiles,
    continued: reference?.[1] ?? "",
  };
}
const peek = ref<{ items: PeekImage[]; index: number } | null>(null);
let peekTrigger: HTMLElement | null = null;
function openPictures(list: { path: string; src: string }[], index: number) {
  peekTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  peek.value = {
    items: list.map((item) => ({ src: item.src, title: item.path.split(/[\\/]/).pop()!, source: item.path })),
    index,
  };
}
async function openViewedImage(path: string) {
  try {
    openPictures([{ path, src: attachmentPicture(path) ?? rawUrl(path, await fileToken()) }], 0);
  } catch (error) {
    showRunError(error);
  }
}
function closePictures() {
  peek.value = null;
  peekTrigger?.focus({ preventScroll: true });
  peekTrigger = null;
}
function pickPicture(index: number) {
  if (peek.value) peek.value.index = index;
}
function stepPicture(by: number) {
  if (!peek.value) return;
  const count = peek.value.items.length;
  pickPicture((peek.value.index + by + count) % count);
}
/** Any picture as a PNG data URL (the attachment store keeps PNGs). */
async function pngData(file: Blob) {
  if (file.type === "image/png")
    return await new Promise<string>((done, fail) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.onerror = () => fail(reader.error);
      reader.readAsDataURL(file);
    });
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.toDataURL("image/png");
}
// Pasting a screenshot (or an image copied anywhere) saves it under
// .orvane/agent-attachments and attaches it like a dropped file; files copied
// in Windows attach by path. Text pastes as usual.
async function pasteFiles(event: ClipboardEvent) {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  const desktop = (window as unknown as { orvaneDesktop?: { pathForFile?(file: File): string } }).orvaneDesktop;
  const added: string[] = [];
  try {
    for (const file of files) {
      const path = desktop?.pathForFile?.(file) ?? "";
      if (path) added.push(path);
      else if (file.type.startsWith("image/"))
        added.push((await agentRequest<{ path: string }>("attachment-save", { data: await pngData(file) })).path);
    }
  } catch (error) {
    showRunError(error);
  }
  if (added.length) paths.value = [...new Set([...paths.value, ...added])].slice(0, 20);
}
// "@" also lists other sessions; picking one adds its latest reply.
const mentionSessions = computed<MentionSession[]>(() =>
  sessions.value
    .filter((session) => session.key !== active.value)
    .slice(0, 60)
    .map((session) => ({
      key: session.key,
      title: session.title,
      provider: session.provider ?? "claude",
      project: session.project,
    })),
);
async function pickMentionSession(session: MentionSession) {
  const field = composer.value;
  const found = mention.value;
  if (field && found) {
    draft.value = draft.value.slice(0, found.start) + draft.value.slice(field.selectionStart);
    mention.value = null;
    await nextTick();
    field.focus({ preventScroll: true });
    field.setSelectionRange(found.start, found.start);
  }
  try {
    const data = await agentRequest<AgentSessionRead>("read", { key: session.key });
    const reply = [...data.messages].reverse().find((message) => message.role !== "user" && message.text);
    composerHandle.addQuote({
      id: `session:${session.key}`,
      kind: "session",
      source: session.title,
      detail: `${agentNames[session.provider as AgentProvider] ?? session.provider} in ${projectName(session.project)}, session ${data.session.sessionId}`,
      text: reply?.text ?? "",
    });
  } catch (cause) {
    showRunError(cause);
  }
}
function openSnapshot() {
  if (!(selected.value || newProvider.value) || snapshotBusy.value) return;
  mention.value = null;
  slash.value = null;
  snapshotOpen.value = true;
}
function closeSnapshot() {
  snapshotOpen.value = false;
  void focusComposer();
}
async function takeSnapshot(appId: string, picture: boolean) {
  snapshotOpen.value = false;
  snapshotBusy.value = true;
  try {
    composerHandle.addQuote(await snapshotApp(appId, picture));
  } catch (cause) {
    showRunError(cause);
  } finally {
    snapshotBusy.value = false;
  }
}

/* ---------- suggested next message ---------- */
function toggleSuggest() {
  harness.settings.suggest = !harness.settings.suggest;
  if (!harness.settings.suggest) suggestion.value = "";
  showNotice(harness.settings.suggest ? "Suggested next message on" : "Suggested next message off");
}
watch(draft, (text) => {
  if (text) suggestion.value = "";
});
watch(
  () => (run.value ? `${run.value.id}:${run.value.status}` : ""),
  async (now, before) => {
    const value = run.value;
    const [id, status] = now.split(":");
    if (!value || status !== "completed" || !before || before.split(":")[0] !== id) return;
    if (!["running", "stopping"].includes(before.split(":")[1]!) || !harness.settings.suggest) return;
    const reply =
      value.text || [...messages.value].reverse().find((message) => message.role !== "user" && message.text)?.text || "";
    if (!reply.trim() || draft.value.trim()) return;
    const ticket = revision;
    try {
      const { text } = await agentRequest<{ text: string }>("suggest", {
        message: value.message.slice(0, 12000),
        reply: reply.slice(-40000),
      });
      if (ticket === revision && run.value?.id === id && !draft.value && harness.settings.suggest)
        suggestion.value = text.trim();
    } catch {
      /* No suggestion this time. */
    }
  },
);

/* ---------- checkpoints and rewind ---------- */
const sameText = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);
// The user message each checkpoint was taken before.
const checkpointOf = computed(() => {
  const found = new Map<string, SessionCheckpoint>();
  const used = new Set<string>();
  for (const checkpoint of checkpoints.value) {
    const want = sameText(checkpoint.message);
    const at = Date.parse(checkpoint.at);
    const match = messages.value.find(
      (message) =>
        message.role === "user" &&
        !used.has(message.id) &&
        sameText(message.text) === want &&
        !(Date.parse(message.at) < at - 120_000),
    );
    if (!match) continue;
    used.add(match.id);
    found.set(match.id, checkpoint);
  }
  return found;
});
async function loadCheckpoints() {
  const session = selected.value;
  if (!session) {
    checkpoints.value = [];
    return;
  }
  try {
    const data = await agentRequest<{ checkpoints: SessionCheckpoint[] }>("checkpoints", {
      sessionId: session.sessionId,
    });
    if (selected.value?.sessionId === session.sessionId)
      checkpoints.value = [...data.checkpoints].sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    checkpoints.value = [];
  }
}
watch(
  () => [selected.value?.sessionId ?? "", run.value && !agentBusy(run.value) ? run.value.id : ""] as const,
  () => void loadCheckpoints(),
  { immediate: true },
);
function rewindLatest() {
  const latest = [...checkpointOf.value.values()].sort((a, b) => b.at.localeCompare(a.at))[0];
  if (latest && !busy.value) rewinding.value = latest;
  else if (!latest) showNotice("No checkpoints in this session yet.");
}
async function restoreCheckpoint(mode: RewindMode) {
  const checkpoint = rewinding.value;
  const session = selected.value;
  if (!checkpoint || !session || busy.value || rewindBusy.value) return;
  const kind = session.provider ?? "claude";
  const messageId = [...checkpointOf.value].find(([, value]) => value === checkpoint)?.[0];
  const index = messages.value.findIndex((message) => message.id === messageId);
  const original = index >= 0 ? messages.value[index]!.text : checkpoint.message;
  if (mode !== "files" && index === 0 && before.value) {
    showRunError(Error("Load earlier messages first, then rewind."));
    return;
  }
  rewindBusy.value = true;
  try {
    let restored = -1;
    if (mode !== "chat") {
      const result = await agentRequest<{ files: unknown[] }>("checkpoint-restore", {
        sessionId: session.sessionId,
        commit: checkpoint.commit,
        provider: kind,
      });
      restored = result.files.length;
    }
    rewinding.value = null;
    if (mode !== "files" && kind === "claude") {
      const previous = index > 0 ? messages.value[index - 1] : undefined;
      if (previous) {
        rewindAt.value = { resumeAt: previous.lastId ?? previous.id, message: original };
        draft.value = original;
      } else {
        // Before the first message: a new session in the same folder.
        const project = session.project;
        back();
        newProvider.value = "claude";
        folder.value = project;
        draft.value = original;
      }
    }
    const files = restored < 0 ? "" : `Restored ${restored} file${restored === 1 ? "" : "s"}. `;
    showNotice(mode === "files" ? `${files}The current files were saved as a checkpoint first.` : `${files}Edit the message and send to continue from there.`);
    await focusComposer();
  } catch (cause) {
    showRunError(cause);
  } finally {
    rewindBusy.value = false;
  }
}
function closeRewind() {
  rewinding.value = null;
  void focusComposer();
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
  if (!older && data.context) {
    const current = run.value?.context ?? sessionContext.value;
    sessionContext.value = data.context.estimatedWindow && current && !current.estimatedWindow &&
      data.context.model === current.model
      ? { ...data.context, window: current.window, estimatedWindow: false }
      : data.context;
  }
  error.value = "";
  if (expanded.value)
    expanded.value =
      data.visuals.find((v) => v.view.id === expanded.value!.view.id) || null;
  if (data.run && agentBusy(data.run)) watchRun(data.run);
  else if (data.run) {
    run.value = data.run;
    markSeen(data.run.id);
    if (data.run.error) showRunError(data.run.error);
  }
  await nextTick();
  if (chat.value && !expanded.value) {
    if (older) chat.value.scrollTop += chat.value.scrollHeight - oldHeight;
    // Only a reader at the very bottom (or a session just opened) follows.
    else if (pinned) chat.value.scrollTop = chat.value.scrollHeight;
  }
  // A continued session asked to show one of this session's messages.
  const reveal = !older && pendingReveals.get(key);
  if (reveal && messages.value.some((m) => m.id === reveal)) {
    pendingReveals.delete(key);
    void revealMessage(reveal);
  }
}
// Follow the end of the conversation only while the reader is at the very
// bottom: anything that grows below (live output, a reply laid out again when
// its run finishes, links resolved late, the call strip) keeps the view there.
// Scrolled up even a little, nothing moves the view (even while a run is
// live) until the reader is back at the bottom or sends a message.
let pinned = true;
const thread = ref<HTMLElement>();
function chatScrolled() {
  const box = chat.value;
  if (box) pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
}
const followEnd = new ResizeObserver(() => {
  const box = chat.value;
  if (box && pinned) box.scrollTop = box.scrollHeight;
});
onMounted(() => thread.value && followEnd.observe(thread.value));
onBeforeUnmount(() => followEnd.disconnect());
/** keepScroll: a new chat turning into its saved session (not the owner
 * opening one), so a reader scrolled up stays where they are. */
async function select(key: string, keepScroll = false) {
  if (sending.value || (newProvider.value && busy.value)) return;
  if (!keepScroll) pinned = true;
  schedulesOpen.value = false;
  settingsOpen.value = false;
  resetComposer();
  newProvider.value = undefined;
  continuing.value = null;
  // A continue reference belongs to its draft, unlike other context chips.
  quotes.value = quotes.value.filter((quote) => !quote.origin);
  const selectedGeneration = ++generation;
  active.value = key;
  saveBlock();
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
        if (!props.pane) await loadSchedules();
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
  schedulesOpen.value = false;
  settingsOpen.value = false;
  resetComposer();
  generation++;
  active.value = "";
  saveBlock();
  expanded.value = null;
  newProvider.value = undefined;
  continuing.value = null;
  messages.value = [];
  visuals.value = [];
  warnings.value = [];
  before.value = null;
  loading.value = false;
}
async function loadSchedules() {
  if (schedulesLoading.value) return;
  schedulesLoading.value = true;
  const previous = schedules.value;
  try {
    const data = await agentRequest<{ schedules: AgentSchedule[] }>("schedules");
    if (schedules.value === previous) schedules.value = data.schedules;
  } catch (cause) {
    if (schedulesOpen.value) error.value = cause instanceof Error ? cause.message : "Scheduled prompts could not be loaded.";
  } finally {
    schedulesLoading.value = false;
  }
}
async function showSettings() {
  if (expanded.value) await collapse();
  schedulesOpen.value = false;
  settingsOpen.value = true;
  await nextTick();
  settingsPane.value?.focus();
}
function closeSettings() {
  settingsOpen.value = false;
  void nextTick(() => settingsButton.value?.focus({ preventScroll: true }));
}
async function showSchedules() {
  if (expanded.value) await collapse();
  settingsOpen.value = false;
  schedulesOpen.value = true;
  void loadSchedules();
  await nextTick();
  schedulesPane.value?.focus();
}
function closeSchedules() {
  schedulesOpen.value = false;
  void nextTick(() => scheduleButton.value?.focus({ preventScroll: true }));
}
async function openScheduledSession(id: string, kind: AgentProvider) {
  try {
    await list();
    const session = sessions.value.find((item) => item.sessionId === id && (item.provider ?? "claude") === kind);
    if (!session) throw Error("The session transcript is not available yet.");
    await select(session.key);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "The session could not be opened.";
  }
}
/* ---------- split panes (host only) ---------- */
const splitOn = computed(() => tiles.value.root.type === "split");
function saveBlock() {
  if (props.pane) return;
  const split = splitOn.value;
  props.block.value =
    active.value || split
      ? JSON.stringify({
          ...(active.value ? { active: active.value } : {}),
          ...(split ? { tiles: tiles.value } : {}),
        })
      : "";
}
const shownKey = computed(() =>
  tiles.value.focus === HOST ? active.value : tiles.value.panes[tiles.value.focus]?.key ?? "",
);
function paneProp(id: string) {
  return { id, ...tiles.value.panes[id], nonce: paneNonces.value[id] ?? 0 };
}
function paneState(id: string, state: PaneSession) {
  if (!(id in tiles.value.panes)) return;
  tiles.value.panes[id] = state;
  saveBlock();
}
function openInPane(id: string, session: PaneSession) {
  tiles.value.panes[id] = session;
  paneNonces.value[id] = (paneNonces.value[id] ?? 0) + 1;
  saveBlock();
}
/** Provider and folder of what a pane shows, for a new session beside it. */
function paneOrigin(id: string): PaneSession {
  const pane: PaneSession =
    id === HOST
      ? { key: active.value || undefined, provider: newProvider.value, folder: folder.value || undefined }
      : tiles.value.panes[id] ?? {};
  const session = pane.key ? sessions.value.find((s) => s.key === pane.key) : undefined;
  return {
    provider: session ? session.provider ?? "claude" : pane.provider ?? provider.value,
    folder: session?.project || pane.folder,
  };
}
function findOpenPane(key: string) {
  if (active.value === key) return HOST;
  return Object.keys(tiles.value.panes).find((id) => tiles.value.panes[id]?.key === key);
}
// Like a Terminal split: the new pane starts a session with the same
// provider and folder as the focused one, unless it is given a session.
function splitPane(dir: "row" | "column" | "auto", open?: PaneSession) {
  const existing = open?.key && findOpenPane(open.key);
  if (existing) return tileView.value?.focusPane(existing, true);
  const from = tiles.value.focus;
  if (dir === "auto") {
    const rect = tileView.value?.rects().get(from);
    dir = rect && rect.h > rect.w ? "column" : "row";
  }
  const id = tileId("pane");
  tiles.value.panes[id] = open ?? paneOrigin(from);
  paneNonces.value[id] = 1;
  tiles.value.root = replaceLeaf(tiles.value.root, from, splitTiles(dir, leaf(from), leaf(id)))!;
  tiles.value.focus = id;
  saveBlock();
}
function closePane(id: string) {
  const ids = leaves(tiles.value.root);
  if (ids.length < 2 || !ids.includes(id)) return;
  const rects = tileView.value?.rects();
  const gone = rects?.get(id);
  const nearest = (candidates: string[]) =>
    candidates.sort((a, b) => {
      const ra = rects?.get(a),
        rb = rects?.get(b);
      if (!gone || !ra || !rb) return 0;
      const d = (r: typeof ra) => Math.hypot(r.x + r.w / 2 - gone.x - gone.w / 2, r.y + r.h / 2 - gone.y - gone.h / 2);
      return d(ra) - d(rb);
    })[0]!;
  if (id === HOST) {
    // The host draws its own pane, so it takes over the nearest pane's
    // session and place.
    if (sending.value || (newProvider.value && busy.value)) return;
    const other = nearest(ids.filter((x) => x !== HOST));
    const session = tiles.value.panes[other] ?? {};
    tiles.value.root = replaceLeaf(replaceLeaf(tiles.value.root, HOST, null)!, other, leaf(HOST))!;
    delete tiles.value.panes[other];
    tiles.value.focus = HOST;
    if (session.key) void select(session.key).then(focusComposer);
    else if (session.provider) {
      void openNew(session.provider).then(() => {
        if (session.folder) folder.value = session.folder;
      });
    } else back();
    tileView.value?.focusPane(HOST, true);
  } else {
    tiles.value.root = replaceLeaf(tiles.value.root, id, null)!;
    delete tiles.value.panes[id];
    if (tiles.value.focus === id) {
      tiles.value.focus = nearest(leaves(tiles.value.root));
      tileView.value?.focusPane(tiles.value.focus, true);
    }
  }
  saveBlock();
}
function openFromList(key: string, event?: MouseEvent) {
  if (props.pane) return select(key);
  if (event && (event.ctrlKey || event.metaKey)) return splitPane("auto", { key });
  // Already open in a pane: go there.
  if (splitOn.value) {
    const open = findOpenPane(key);
    if (open) {
      tiles.value.focus = open;
      return;
    }
  }
  const at = tiles.value.focus;
  if (!splitOn.value || at === HOST) return select(key);
  openInPane(at, { key });
}
function newInFocused(kind: AgentProvider) {
  const at = tiles.value.focus;
  if (!splitOn.value || at === HOST) return openNew(kind);
  openInPane(at, { provider: kind, folder: paneOrigin(at).folder });
}
if (props.pane) {
  watch([active, newProvider, folder], () =>
    emit(
      "pane-state",
      active.value ? { key: active.value } : { provider: newProvider.value, folder: folder.value || undefined },
    ),
  );
  watch(
    () => props.pane?.nonce,
    () => {
      const pane = props.pane;
      if (!pane) return;
      if (pane.key) {
        if (pane.id === "side" && newProvider.value && busy.value) back();
        if (pane.key !== active.value || !messages.value.length) void select(pane.key).then(() => {
          if (!pane.quiet) return focusComposer();
        });
        else if (!pane.quiet) void focusComposer();
      } else if (pane.initialDraft) {
        const continued = pane.initialDraft.quotes?.some((quote) => quote.origin);
        void loadPinnedDraft(pane.initialDraft).then(() => {
          if (continued && !pane.quiet) return focusComposerEnd();
        });
      } else if (pane.provider) {
        void openNew(pane.provider).then(() => {
          if (pane.folder) folder.value = pane.folder;
        });
      }
    },
    { immediate: !!props.pane.nonce, flush: "post" },
  );
}
if (props.pane?.id === "side") {
  watch(
    [newProvider, folder, draft, paths, quotes, model, effort, editMode, () => run.value?.id],
    () => { if (newProvider.value) emit("draft-state", currentDraft(newProvider.value)); },
    { flush: "post" },
  );
}
// With split panes, Ctrl+K lists the focused pane's session commands only.
const sessionCommandsOn = () =>
  props.pane ? !!props.focused : !splitOn.value || tiles.value.focus === HOST;
const unregister = registerCommands(`agent-sessions:${props.block.id}${props.pane ? `:${props.pane.id}` : ""}`, () => [
  ...(props.pane
    ? []
    : [
        {
          id: `agent-split-right:${props.block.id}`,
          title: "Split session right",
          icon: "agent-sessions",
          hint: "Alt+Shift+=",
          blockId: props.block.id,
          run: () => splitPane("row"),
        },
        {
          id: `agent-split-down:${props.block.id}`,
          title: "Split session down",
          icon: "agent-sessions",
          hint: "Alt+Shift+-",
          blockId: props.block.id,
          run: () => splitPane("column"),
        },
        ...(splitOn.value
          ? [{
              id: `agent-split-close:${props.block.id}`,
              title: "Close session pane",
              icon: "close",
              hint: "Ctrl+Shift+W",
              blockId: props.block.id,
              run: () => closePane(tiles.value.focus),
            }]
          : []),
      ]),
  ...(sessionCommandsOn() ? sessionCommands() : []),
]);
function sessionCommands() { return [
  {
    id: `agent-schedules:${props.block.id}`,
    title: "Show scheduled prompts",
    icon: "clock",
    blockId: props.block.id,
    run: showSchedules,
  },
  {
    id: `agent-settings:${props.block.id}`,
    title: "Agent sessions settings (Orvane MCP)",
    icon: "settings",
    blockId: props.block.id,
    run: showSettings,
  },
  ...(contextNow.value && !schedulesOpen.value
    ? [{
        id: `agent-context:${props.block.id}`,
        title: "Show context usage",
        icon: "agent-sessions" as const,
        blockId: props.block.id,
        run: () => contextRing.value?.toggle(),
      }]
    : []),
  ...(newProvider.value && props.pane?.id !== "side"
    ? [{ id: `agent-pin-draft:${props.block.id}`, title: "Pin new session", icon: "pin" as const,
        blockId: props.block.id, run: pinNew }]
    : []),
  ...(selected.value || newProvider.value
    ? [{
        id: `agent-snapshot:${props.block.id}`,
        title: "Snapshot an app into the message",
        icon: "image" as const,
        hint: "Ctrl+Alt+S",
        blockId: props.block.id,
        run: async () => {
          await focusComposer();
          openSnapshot();
        },
      }]
    : []),
  ...(checkpointOf.value.size && !busy.value
    ? [{
        id: `agent-rewind:${props.block.id}`,
        title: "Rewind to the last checkpoint",
        icon: "undo" as const,
        hint: "Ctrl+Alt+Z",
        blockId: props.block.id,
        run: rewindLatest,
      }]
    : []),
  {
    id: `agent-suggest:${props.block.id}`,
    title: harness.settings.suggest ? "Turn off suggested next message" : "Turn on suggested next message",
    icon: "text",
    blockId: props.block.id,
    run: toggleSuggest,
  },
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
  ...(selected.value
    ? [{
        id: `agent-continue:${props.block.id}`,
        title: "Continue with another model…",
        icon: "git" as const,
        hint: "Ctrl+Alt+M",
        keywords: "handoff codex claude model new session reference transcript",
        blockId: props.block.id,
        run: openContinue,
      }]
    : []),
  ...(fromSource.value
    ? [{
        id: `agent-continue-source:${props.block.id}`,
        title: `Open source session: ${fromSource.value.title}`,
        icon: "agent-sessions" as const,
        hint: "Ctrl+Alt+O",
        blockId: props.block.id,
        run: () => openSource(),
      }]
    : []),
  ...(provider.value === "claude" && selected.value && !busy.value
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
]; }
let unregisterComposer = () => {};
onMounted(() => {
  unregisterComposer = registerComposer(composerHandle);
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
  () => (props.pane ? undefined : agentOpenRequests.get(props.block.id)),
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
  unregisterComposer();
  resetComposer();
  visibility?.disconnect();
  stopped = true;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <div ref="root" class="agent-sessions-app" :class="{ 'cs-pane-mode': pane, 'cs-pinned': pane?.id === 'side' }" @keydown="appKey">
    <header v-if="!pane" class="cs-toolbar">
      <span class="cs-title"
        ><Icon name="agent-sessions" :size="16" /><span>Agent sessions</span></span
      >
      <button
        type="button"
        class="cs-btn"
        title="New Claude Code session"
        :disabled="sending || (!!newProvider && busy)"
        @click="newInFocused('claude')"
      >
        <Icon name="plus" :size="14" />Claude
      </button>
      <button
        type="button"
        class="cs-btn"
        title="New Codex session"
        :disabled="sending || (!!newProvider && busy)"
        @click="newInFocused('codex')"
      >
        <Icon name="plus" :size="14" />Codex
      </button>
      <ActivityBell @open="openRecent" />
      <button
        class="cs-btn cs-icon cs-ghost"
        type="button"
        title="Session shortcuts"
        aria-label="Session shortcuts"
        aria-haspopup="dialog"
        :aria-expanded="!!tilePopover && !tilePopover.key"
        @click="showTilePopover($event)"
      >
        <Icon name="keyboard" :size="14" />
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
        'cs-has-selection': active || newProvider || schedulesOpen || settingsOpen,
        'cs-focus': expanded,
        'cs-scheduled-layout': schedulesOpen || settingsOpen,
        'cs-pane-layout': pane,
      }"
    >
      <nav v-if="!pane" v-show="!expanded" class="cs-sidebar" aria-label="Agent sessions">
        <button ref="scheduleButton" type="button" class="cs-schedule-nav"
          :aria-current="schedulesOpen ? 'page' : undefined"
          @click="schedulesOpen ? closeSchedules() : showSchedules()">
          <Icon name="clock" :size="14" />Scheduled <span>{{ schedules.length }}</span>
        </button>
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
              :class="{ selected: shownKey === s.key, 'cs-child': childKeys.has(s.key) }"
              :title="childKeys.has(s.key) ? `Continued from ${agentLineage.get(s.key)?.title}` : undefined"
              :aria-current="shownKey === s.key ? 'true' : undefined"
              :disabled="sending || (!!newProvider && busy)"
              @click="openFromList(s.key, $event)"
              @contextmenu.prevent.stop="showTilePopover($event, s.key)"
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
        <button ref="settingsButton" type="button" class="cs-schedule-nav cs-settings-nav"
          :aria-current="settingsOpen ? 'page' : undefined"
          @click="settingsOpen ? closeSettings() : showSettings()">
          <Icon name="settings" :size="14" />Settings
        </button>
      </nav>
      <section v-if="schedulesOpen && !pane" class="cs-scheduled-view">
        <button type="button" class="cs-btn cs-ghost cs-scheduled-back" @click="closeSchedules">
          <Icon name="back" :size="14" />Sessions
        </button>
        <ScheduledPrompts ref="schedulesPane" v-model="schedules" :loading="schedulesLoading"
          :model-options="modelOptionsFor" @load-models="loadModels" @open-session="openScheduledSession" />
      </section>
      <section v-if="settingsOpen && !pane" class="cs-scheduled-view">
        <AgentSettings ref="settingsPane" :suggest="harness.settings.suggest" @update:suggest="toggleSuggest" />
      </section>
      <AgentTiles
        v-show="!schedulesOpen && !settingsOpen"
        ref="tileView"
        class="cs-tiles"
        :class="{ 'cs-tiles-empty': !active && !newProvider && !splitOn }"
        :root="pane ? paneRoot : tiles.root"
        :focus="pane ? HOST : tiles.focus"
        :nested="!!pane"
        @update:root="(root) => { tiles.root = root; saveBlock(); }"
        @update:focus="(id) => (tiles.focus = id)"
        @split="(dir) => splitPane(dir)"
        @close="closePane"
      >
        <template #pane="{ id }">
          <template v-if="id === HOST">
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
            <strong data-tile-grip>{{
              newProvider
                ? `New ${agentNames[newProvider]} session`
                : selected?.title || "Session"
            }}</strong>
            <span class="cs-head-meta" :class="{ 'cs-linked': fromSource || continuedIn }">
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
              <template v-if="fromSource">
                <span class="cs-sep">·</span>
                <button type="button" class="cs-lineage" :title="`Open ${fromSource.title} (Ctrl+Alt+O)`"
                  @click="openSource()"><Icon name="git" :size="12" />from <b>{{ fromSource.title }}</b></button>
              </template>
              <template v-else-if="continuedIn">
                <span class="cs-sep">·</span>
                <button type="button" class="cs-lineage" :title="`Go to ${continuedIn.label}`"
                  @click="continuedIn.go()"><Icon name="git" :size="12" />continued in <b>{{ continuedIn.label }}</b></button>
              </template>
            </span>
          </div>
          <KeepAwake v-if="working" />
          <button v-if="newProvider && pane?.id !== 'side'" type="button"
            class="cs-btn cs-icon cs-ghost" aria-label="Pin new session" title="Pin new session"
            :disabled="sending" @click="pinNew">
            <Icon name="pin" :size="14" />
          </button>
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
              <button type="button" role="menuitem" :aria-pressed="harness.settings.suggest" @click="menuAction('suggest')">
                <Icon :name="harness.settings.suggest ? 'check' : 'text'" :size="14" /><span>Suggest next message</span>
              </button>
              <hr />
              <button type="button" role="menuitem" @click="openContinue">
                <Icon name="git" :size="14" /><span>Continue with another model</span><kbd class="cs-menu-kbd">Ctrl Alt M</kbd>
              </button>
              <hr />
              <button type="button" role="menuitem" @click="menuAction('reload')">
                <Icon name="refresh" :size="14" /><span>Reload transcript</span>
              </button>
            </div>
            <ContinuePicker v-if="continueOpen === 'menu'" ref="continueMenu" class="cs-continue-pop"
              :options="continueOptions" :place="continuePlace"
              :current="{ provider, model }"
              @pick="pickContinue" @close="closeContinue(true)" />
          </span>
        </header>
        <div class="cs-content">
          <div
            v-show="!expanded"
            ref="chat"
            class="cs-chat"
            aria-label="Session conversation"
            @scroll.passive="chatScrolled"
          >
            <SessionTimeline
              v-if="timeline && selected"
              class="cs-timeline"
              :messages="messages"
              :approvals="approvals"
              :base="selected.project"
              @close="closeTimeline"
            />
            <div v-show="!timeline" ref="thread" class="cs-thread">
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
              <ContinueCard v-if="newProvider && !live && !run && sourceQuote" :quote="sourceQuote" :to="newProvider"
                @open="openSource" />
              <div v-else-if="newProvider && !live && !run" class="cs-hello">
                <span class="cs-mark cs-mark-lg"><Icon name="ai" :size="20" /></span>
                <strong>New {{ agentNames[newProvider] }} session</strong>
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
                :data-message-id="m.id"
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
                  <button
                    v-if="m.role === 'user' && checkpointOf.get(m.id)"
                    type="button"
                    class="cs-rewind"
                    :disabled="busy"
                    title="Rewind to before this message (Ctrl+Alt+Z for the latest)"
                    @click="rewinding = checkpointOf.get(m.id)!"
                  >
                    <Icon name="undo" :size="12" /><span>Checkpoint</span>
                  </button>
                  <MessageActions
                    v-if="m.text"
                    :user="m.role === 'user'"
                  :can-fork="provider === 'claude' && !!selected && !busy"
                    @action="messageAction($event, m.text)"
                  />
                </div>
                <!-- The reply's tool calls, folded into a time strip above its text. -->
                <AgentRunActivity
                  @view-image="openViewedImage"
                  v-if="m.tools.length || index === runStripAt"
                  class="cs-tool-steps"
                  strip
                  collapsed
                  :items="m.tools.length ? toolSteps(m, index === messages.length - 1) : run!.activities!"
                />
                <!-- A message's pasted pictures above its text, as sent. -->
                <ul v-if="m.role === 'user' && userParts(m.text).pictures.length" class="cs-pictures cs-sent-pictures" aria-label="Pictures sent">
                  <li v-for="(picture, index) in userParts(m.text).pictures" :key="picture.path">
                    <button type="button" class="cs-picture" :aria-label="`Open ${picture.path}`"
                      @click="openPictures(userParts(m.text).pictures, index)"><img :src="picture.src" alt="" /></button>
                  </li>
                </ul>
                <ChatMarkdown
                  v-if="m.role === 'user' ? userParts(m.text).text.trim() : m.text"
                  class="cs-message-text"
                  :text="m.role === 'user' ? userParts(m.text).text : m.text"
                  :base="selected?.project || run?.folder"
                />
                <button v-if="m.role === 'user' && userParts(m.text).continued" type="button" class="cs-sent-ref"
                  :title="fromSource ? `Open ${fromSource.title}` : undefined" :disabled="!fromSource" @click="openSource()">
                  <Icon name="agent-sessions" :size="12" /><b>@{{ userParts(m.text).continued }}</b>full transcript
                </button>
                <span v-if="m.truncated" class="cs-muted"
                  >Message shortened for display. The transcript is
                  unchanged.</span
                >
                <ExpositionView
                  v-for="v in attachment.map.get(m.id) || []"
                  :key="v.view.id"
                  :visual="v"
                  @expand="expand"
                />
              </article>
              <article v-if="live && run" class="cs-message cs-user">
                <div class="cs-message-meta"><strong>You</strong></div>
                <ul v-if="userParts(run.message).pictures.length" class="cs-pictures cs-sent-pictures" aria-label="Pictures sent">
                  <li v-for="(picture, index) in userParts(run.message).pictures" :key="picture.path">
                    <button type="button" class="cs-picture" :aria-label="`Open ${picture.path}`"
                      @click="openPictures(userParts(run.message).pictures, index)"><img :src="picture.src" alt="" /></button>
                  </li>
                </ul>
                <ChatMarkdown v-if="userParts(run.message).text.trim()" class="cs-message-text" :text="userParts(run.message).text" />
                <span v-if="userParts(run.message).continued" class="cs-sent-ref">
                  <Icon name="agent-sessions" :size="12" /><b>@{{ userParts(run.message).continued }}</b>full transcript
                </span>
              </article>
              <template v-if="live && run?.steered?.length">
                <article v-for="item in run.steered" :key="item.at" class="cs-message cs-user cs-steered">
                  <div class="cs-message-meta"><strong>You</strong><span class="cs-steer-tag">mid-turn</span></div>
                  <ChatMarkdown class="cs-message-text" :text="item.text" />
                </article>
              </template>
              <ThinkingTrail
                @view-image="openViewedImage"
                v-if="working && run"
                :key="'trail:' + run.id"
                :items="run.activities ?? []"
                :texts="run.textParts"
                :base="run.folder"
                :status="run.permissions.length ? '' : run.activity"
              >
                <template #head="{ stepWorking }">
                  <DnaHelix v-if="!stepWorking" />
                  <strong class="cs-trail-state">{{ trailLabel }}</strong>
                  <time v-if="elapsed" class="cs-trail-time">{{ elapsed }}</time>
                </template>
              </ThinkingTrail>
              <AgentRunActivity
                @view-image="openViewedImage"
                v-else-if="run?.activities?.length && runStripAt === -1"
                :key="run.id"
                class="cs-tool-steps"
                strip
                collapsed
                :items="run.activities"
              />
              <section v-if="run?.queued?.length" class="cs-queue" aria-label="Queued follow-ups">
                <header>
                  <strong>Then</strong>
                  <span>{{ working ? "sent when this run ends" : run.status === "failed" ? "run failed" : run.status === "stopped" ? "run stopped" : "waiting to send" }}</span>
                  <span class="cs-queue-count">{{ run.queued.length }} queued</span>
                </header>
                <ol aria-label="Queued messages">
                  <li v-for="(item, index) in run.queued" :key="item.id">
                    <span class="cs-queue-number" aria-hidden="true">{{ index + 1 }}</span>
                    <span class="cs-queue-text" :title="item.text">{{ queueLine(item.text) }}</span>
                    <button
                      v-if="run.provider === 'claude' && run.status === 'running'"
                      type="button"
                      class="cs-btn cs-ghost"
                      :disabled="queuePending"
                      title="Give it to the working turn now, between tool calls"
                      @click="queueCommand('steer', item)"
                    >Steer</button>
                    <button type="button" class="cs-btn cs-ghost" :disabled="queuePending" @click="editQueued(item)">Edit</button>
                    <button type="button" class="cs-btn cs-ghost" :disabled="queuePending" @click="queueCommand('queue-now', item)">Send now</button>
                    <button type="button" class="cs-btn cs-ghost" :disabled="queuePending" @click="queueCommand('unqueue', item)">Remove</button>
                  </li>
                </ol>
              </section>
              <FilesChanged
                v-if="run && !working"
                :key="'files:' + run.id"
                :run-id="run.id"
                :folder="run.folder"
                @ask="askAbout"
              />
              <!-- While it works the text sits in the trail, between its steps. -->
              <article v-if="live && run?.text && !(working && run.textParts)" class="cs-message cs-live">
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
          :class="{ 'cs-dropping': dropping }"
          @submit.prevent="send()"
          @dragenter="dragOver"
          @dragover="dragOver"
          @dragleave="dragLeave"
          @drop="dropFiles"
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
              :sessions="mentionSessions"
              @pick="pickMention"
              @pick-session="pickMentionSession"
            />
          </div>
          <div v-if="snapshotOpen" class="cs-picker-anchor">
            <SnapshotPicker @pick="takeSnapshot" @close="closeSnapshot" />
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
            <RewindCard
              v-if="rewinding && selected"
              :key="rewinding.commit"
              :checkpoint="rewinding"
              :session-id="selected.sessionId"
              :provider="selected.provider ?? 'claude'"
              :can-chat="(selected.provider ?? 'claude') === 'claude'"
              :busy="busy || rewindBusy"
              @restore="restoreCheckpoint"
              @close="closeRewind"
            />
            <template v-for="permission in run?.permissions" :key="permission.id">
            <AgentQuestions
              v-if="askedQuestions(permission)"
              :questions="askedQuestions(permission)!"
              :who="agentNames[run!.provider]"
              :codex="run!.provider === 'codex'"
              @answer="runCommand('permission', { requestId: permission.id, allow: true, ...$event })"
              @skip="runCommand('permission', { requestId: permission.id, allow: false })"
            />
            <div
              v-else
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
            </template>
            <p v-if="notice" class="cs-notice" role="status">{{ notice }}</p>
            <p v-if="forking" class="cs-notice cs-forking" role="status">
              <Icon name="git" :size="12" />The next message starts a new session branched from this one.
              <button type="button" class="cs-btn cs-ghost cs-small" @click="forking = false">Cancel</button>
            </p>
            <p v-if="rewindAt" class="cs-notice cs-forking" role="status">
              <Icon name="undo" :size="12" />The next message continues from before this message, as a new branch of the session.
              <button type="button" class="cs-btn cs-ghost cs-small" @click="rewindAt = null">Cancel</button>
            </p>
            <p v-if="runError" class="cs-run-error cs-card" role="alert">
              {{ runError }}
            </p>
            <div class="agent-composer cs-composer">
              <p v-if="dropping" class="cs-drop-hint" aria-hidden="true">Drop to attach</p>
              <ImagePeek v-if="peek" :items="peek.items" :index="peek.index" thumbnails @close="closePictures" @step="stepPicture" @pick="pickPicture" />
              <ul v-if="draftPictures.length" class="cs-pictures" aria-label="Pictures sent with the message">
                <li v-for="(picture, index) in draftPictures" :key="picture.path">
                  <button type="button" class="cs-picture" :aria-label="`Open ${picture.path}`" @click="openPictures(draftPictures, index)">
                    <img :src="picture.src" alt="" />
                  </button>
                  <button type="button" class="cs-picture-remove" :aria-label="`Remove ${picture.path}`"
                    @click="paths = paths.filter((item) => item !== picture.path)"><Icon name="close" :size="11" /></button>
                </li>
              </ul>
              <ul v-if="quotes.length" class="cs-quotes" aria-label="Context sent with the message">
                <li v-for="quote in quotes" :key="quote.id" :class="quote.kind">
                  <Icon
                    :name="quote.kind === 'session' ? 'agent-sessions' : quote.kind === 'snapshot' ? 'image' : 'text'"
                    :size="12"
                  />
                  <span class="cs-quote-source">{{ quote.kind === "session" ? "@" : "" }}{{ quote.source }}</span>
                  <span class="cs-quote-text" :title="quote.text">{{ quoteLine(quote) }}</span>
                  <span v-if="quote.image" class="cs-quote-tag">picture</span>
                  <button type="button" :aria-label="`Remove ${quote.source}`" @click="removeQuote(quote.id)">
                    <Icon name="close" :size="12" />
                  </button>
                </li>
              </ul>
              <textarea
                ref="composer"
                v-model="draft"
                aria-label="Message"
                :class="{ 'cs-suggesting': suggestion }"
                :placeholder="suggestion || 'Write a message…'"
                rows="2"
                maxlength="12000"
                aria-keyshortcuts="Enter Shift+Enter Control+Enter Control+Shift+Enter Escape @ / Shift+Tab Control+Alt+S Control+Alt+Z"
                @focus="touchComposer(composerHandle)"
                @keydown="composerKey"
                @paste="pasteFiles"
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
                <button
                  type="button"
                  class="cs-btn cs-ghost cs-small"
                  :aria-expanded="snapshotOpen"
                  :disabled="snapshotBusy"
                  title="Snapshot an app (Ctrl+Alt+S)"
                  @pointerdown.prevent
                  @click="openSnapshot"
                >
                  <Icon name="image" :size="13" />{{ snapshotBusy ? "Capturing…" : "Snapshot" }}
                </button>
                <span v-if="suggestion && !draft" class="cs-suggest-hint"
                  ><kbd>Tab</kbd> use suggestion <kbd>Esc</kbd> dismiss</span
                >
                <span v-for="path in draftFiles" :key="path" class="cs-attachment" :title="path"
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
                <!-- A continued draft picks its model across both CLIs. -->
                <span v-if="sourceQuote" class="cs-continue-anchor">
                  <button ref="continuePill" type="button" class="select-trigger cs-model cs-continue-model"
                    aria-haspopup="dialog" :aria-expanded="continueOpen === 'pill'" title="Change model (Ctrl+Alt+M)"
                    @click="continueOpen === 'pill' ? closeContinue() : openContinue()">
                    <span class="select-trigger-icon-label"><Icon name="cpu" :size="13" /><span>{{
                      modelOptions.find((option) => option.value === model)?.label || model || "Provider default"
                    }}</span></span><Icon name="down" :size="12" />
                  </button>
                  <ContinuePicker v-if="continueOpen === 'pill'" ref="continueMenu" class="cs-continue-up"
                    :options="continueOptions" place="beside" change
                    @pick="pickContinue" @close="closeContinue(true)" />
                </span>
                <CustomSelect
                  v-else
                  v-model="model"
                  class="cs-model"
                  aria-label="Model"
                  :options="modelOptions"
                  search-label="Find a model"
                  popover-class="select-fixed-search"
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
                      ? askedQuestions(run.permissions[0]!) ? "Waiting for your answers" : "Waiting for approval"
                      : run?.status === "stopping"
                        ? "Stopping…"
                        : "Running · Enter queues"
                  }}</span
                >
                <span
                  v-else-if="run?.status === 'stopped'"
                  class="cs-status"
                  role="status"
                  >Stopped</span
                >
                <span v-else class="cs-status-space" aria-hidden="true" />
                <div class="cs-send-controls">
                  <AgentUsage v-if="!schedulesOpen" ref="usagePill" :provider="provider" />
                  <!-- Queue sits beside the ring; Stop takes Send's round place in it. -->
                  <button v-if="busy && run?.status === 'running' && hasDraft" type="button"
                    class="cs-btn cs-primary cs-queue-btn" :disabled="queuePending"
                    :title="run?.provider === 'claude'
                      ? 'Enter to queue · Ctrl+Enter to steer now · Ctrl+Shift+Enter to stop and send · Alt+↑ to edit'
                      : 'Enter to queue · Ctrl+Enter to interrupt · Alt+↑ to edit'"
                    @click="queueDraft()"><Icon name="list" :size="14" />Queue</button>
                  <ContextRing
                    v-if="!schedulesOpen"
                    ref="contextRing"
                    :context="contextNow"
                    :ring="true"
                    :can-compact="provider === 'claude' && !!selected && !busy"
                    :can-fork="provider === 'claude' && !!selected && !busy"
                    @compact="send('/compact')"
                    @fork="startFork"
                  >
                    <button v-if="busy" type="button" class="cs-btn cs-stop" aria-label="Stop" title="Stop"
                      :disabled="run?.status !== 'running'" @click="runCommand('stop')">
                      <Icon name="stop" :size="11" />
                    </button>
                    <button v-else type="submit" class="cs-btn cs-primary cs-send"
                      aria-label="Send" title="Send" :disabled="!hasDraft || (!!newProvider && !folder.trim())">
                      <Icon name="up" :size="16" />
                    </button>
                  </ContextRing>
                </div>
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
          </template>
          <AgentSessions
            v-else
            :block="block"
            :pane="paneProp(id)"
            :focused="tiles.focus === id"
            @pane-state="paneState(id, $event)"
            @continue="continueBeside(id, $event)"
          />
        </template>
      </AgentTiles>
    </div>
    <div
      v-if="tilePopover"
      ref="tilePopup"
      class="cs-menu cs-tile-popover select-popover"
      :role="tilePopover.key ? 'menu' : 'dialog'"
      :aria-label="tilePopover.key ? 'Open session in a tile' : 'Session shortcuts'"
      :style="{ left: tilePopover.x + 'px', top: tilePopover.y + 'px' }"
      tabindex="-1"
      @keydown="menuKey($event, closeTilePopover)"
    >
      <button v-if="tileAlreadyOpen" type="button" role="menuitem" @click="tileSession('auto')">
        <Icon name="layers" :size="14" />Focus existing pane<kbd class="cs-menu-kbd">Ctrl+click</kbd>
      </button>
      <template v-else-if="tilePopover.key">
        <button type="button" role="menuitem" @click="tileSession('auto')">
          <Icon name="layers" :size="14" />Open in new pane<kbd class="cs-menu-kbd">Ctrl+click</kbd>
        </button>
        <button type="button" role="menuitem" @click="tileSession('row')">Open to the right</button>
        <button type="button" role="menuitem" @click="tileSession('column')">Open below</button>
      </template>
      <dl v-else class="cs-tile-shortcuts">
        <div v-for="[label, shortcut] in tileShortcuts" :key="label">
          <dt>{{ label }}</dt><dd><kbd>{{ shortcut }}</kbd></dd>
        </div>
      </dl>
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
.cs-layout.cs-focus,
.cs-layout.cs-pane-layout {
  grid-template-columns: minmax(0, 1fr);
}
.cs-tiles {
  min-width: 0;
  min-height: 0;
}
.cs-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--cs-line);
}
.cs-schedule-nav {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 30px;
  margin: 8px 10px 0;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #455968;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cs-schedule-nav:hover, .cs-schedule-nav[aria-current] { background: #e4edf2; color: #273f50; }
.cs-schedule-nav svg { color: #6f8998; }
.cs-settings-nav { margin: auto 10px 10px; }
.cs-schedule-nav span { margin-left: auto; font: 11px "Cascadia Code", Consolas, monospace; color: #657b89; }
.cs-scheduled-view { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.cs-scheduled-view > .scheduled { flex: 1; }
.agent-sessions-app .cs-scheduled-back { display: none; }
.cs-queue {
  position: relative;
  margin-left: 26px;
  padding: 9px 11px 9px 12px;
  border: 1px dashed #b9cbd6;
  border-radius: 10px;
  background: #f2f6f8;
}
.cs-queue::before {
  position: absolute;
  top: -12px;
  left: -17px;
  width: 16px;
  height: 26px;
  border-left: 1px solid #b9cbd6;
  border-bottom: 1px solid #b9cbd6;
  border-bottom-left-radius: 8px;
  content: "";
  pointer-events: none;
}
.cs-queue header { display: flex; align-items: baseline; gap: 7px; color: #657b89; font-size: 11px; }
.cs-queue header strong { text-transform: uppercase; letter-spacing: .04em; font-size: 10.5px; font-weight: 600; }
.cs-queue-count { margin-left: auto; }
.cs-queue ol { display: grid; gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
.cs-queue li { display: flex; align-items: center; gap: 4px; min-height: 26px; padding: 3px 6px; border-radius: 6px; }
.cs-queue li:hover, .cs-queue li:focus-within { background: #e4edf2; }
.cs-queue-number { margin-right: 4px; color: #657b89; font: 11px "Cascadia Code", Consolas, monospace; }
.cs-queue-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #273f50; }
.cs-queue .cs-btn { flex: none; height: 22px; padding: 0 5px; font-size: 11px; }
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
/* Continue with another model (UI Maker r3) */
.cs-menu .cs-menu-kbd {
  margin-left: auto;
  padding-left: 12px;
  white-space: nowrap;
}
.cs-tile-popover {
  right: auto;
  z-index: 20;
  width: max-content;
  min-width: min(210px, calc(100% - 8px));
  max-width: calc(100% - 8px);
  max-height: calc(100% - 8px);
  overflow: auto;
}
.cs-tile-shortcuts {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 8px;
}
.cs-tile-shortcuts > div {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.cs-tile-shortcuts dd {
  margin: 0;
  white-space: nowrap;
}
.cs-continue-pop {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 10;
  animation: cs-pop 130ms ease-out;
}
.cs-continue-anchor {
  position: relative;
  display: inline-flex;
  min-width: 0;
}
.cs-continue-up {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 10;
  animation: cs-pop 130ms ease-out;
}
.agent-sessions-app .cs-lineage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  height: 20px;
  margin-left: -2px;
  padding: 0 6px 0 4px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: #385d76;
  font-size: 11.5px;
  white-space: nowrap;
}
.cs-lineage:hover,
.cs-lineage:focus-visible {
  background: var(--cs-hover);
  outline: none;
}
.cs-lineage b {
  min-width: 0;
  overflow: hidden;
  font-weight: 550;
  text-overflow: ellipsis;
}
.cs-lineage :deep(svg) {
  flex: none;
}
.agent-sessions-app .cs-session.cs-child {
  position: relative;
  width: calc(100% - 14px);
  margin-left: 14px;
}
.cs-session.cs-child::before {
  content: "";
  position: absolute;
  top: -3px;
  left: -8px;
  width: 7px;
  height: 18px;
  border-bottom: 1.5px solid #c9d7e0;
  border-left: 1.5px solid #c9d7e0;
  border-bottom-left-radius: 5px;
}
.agent-sessions-app .cs-sent-ref {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  justify-self: end;
  max-width: min(560px, 86%);
  height: 22px;
  padding: 0 8px;
  border: 0;
  border-left: 2px solid #6f8998;
  border-radius: 0 5px 5px 0;
  background: #eef3f6;
  color: #5d7381;
  font-size: 11.5px;
  white-space: nowrap;
}
.cs-sent-ref:not(:disabled):hover {
  background: #e4edf2;
}
.cs-sent-ref:disabled {
  cursor: default;
}
.cs-sent-ref b {
  min-width: 0;
  overflow: hidden;
  color: #273f50;
  font-weight: 550;
  text-overflow: ellipsis;
}
.cs-sent-ref :deep(svg) {
  flex: none;
  color: #6f8998;
}
.cs-head-meta.cs-linked > .cs-path {
  max-width: 96px;
  flex-shrink: 6;
  min-width: 0;
}
.cs-lineage b {
  min-width: 8ch;
}
.cs-message.cs-flash {
  border-radius: 8px;
  animation: cs-flash 1.2s ease-out;
}
@keyframes cs-flash {
  0%,
  30% {
    background: #e2ebf1;
    box-shadow: 0 0 0 6px #e2ebf1;
  }
  100% {
    background: transparent;
    box-shadow: 0 0 0 6px transparent;
  }
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
.cs-rewind {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: none;
  color: #7a8f9b;
  font-size: 11px;
}
.cs-rewind:hover:not(:disabled) {
  border-color: var(--cs-line2);
  background: var(--cs-hover);
  color: #385d76;
}
.cs-rewind:disabled {
  opacity: 0.5;
}
.cs-steer-tag {
  color: #7a8f9b;
  font-size: 11px;
}
.cs-compose.cs-dropping .cs-composer {
  border-color: #6f8998;
  box-shadow: 0 0 0 3px #6f899826;
}
.cs-drop-hint {
  margin: 0;
  padding: 4px 10px 0;
  color: #385d76;
  font-size: 11.5px;
}
.cs-quotes {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 6px 8px 0;
  list-style: none;
}
.cs-quotes li {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 24px;
  padding: 0 4px 0 8px;
  border-left: 2px solid #9fb7c5;
  border-radius: 0 5px 5px 0;
  background: #eef3f6;
  font-size: 11.5px;
}
.cs-quotes li.session {
  border-left-color: #6f8998;
}
.cs-quotes li :deep(svg) {
  flex: none;
  color: #6f8998;
}
.cs-quote-source {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  color: #273f50;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-quote-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #5d7381;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-quote-tag {
  flex: none;
  color: #7a8f9b;
  font-size: 10.5px;
}
.cs-quotes button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: #7a8f9b;
}
.cs-quotes button:hover {
  background: #dfe8ed;
}
.cs-composer textarea.cs-suggesting::placeholder {
  color: #8fa3ae;
  font-style: italic;
}
.cs-suggest-hint {
  color: #8296a2;
  font-size: 11px;
  white-space: nowrap;
}
.cs-suggest-hint kbd {
  margin: 0 2px;
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
  /* The dock scrolls, so it clips whatever its box doesn't hold. The side and
     bottom padding leave room for the composer's shadow and rounded corners;
     the negative margins keep the cards at the same 760px width and place. */
  max-height: 70cqh;
  margin: 0 max(-20px, calc((100% - 800px) / 2)) -14px;
  padding: 0 20px 14px;
  display: grid;
  gap: 8px;
  overflow: auto;
  pointer-events: none;
}
.cs-dock > * {
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
/* Pasted pictures (UI Maker "Composer images", Tiles): tiles at the top of
   the composer, and above the message they were sent with. */
.cs-pictures {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
}
.cs-pictures li {
  position: relative;
}
.cs-picture {
  display: block;
  padding: 0;
  border: 1px solid #d3dee5;
  border-radius: 8px;
  background: #fff;
  overflow: hidden;
  box-shadow: 0 1px 2px #263f5512;
  cursor: zoom-in;
  transition: box-shadow 0.14s ease-out, border-color 0.14s ease-out;
}
.cs-picture:hover {
  border-color: #9fb6c3;
  box-shadow: 0 4px 12px #263f5518;
}
.cs-picture:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px #6f899840;
}
.cs-picture img {
  display: block;
  width: 84px;
  height: 60px;
  object-fit: cover;
}
.cs-sent-pictures {
  justify-content: flex-end;
  margin: 2px 0 6px;
}
.cs-sent-pictures .cs-picture img {
  width: 96px;
  height: 64px;
}
.agent-sessions-app .cs-picture-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  place-items: center;
  gap: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #273f50cc;
  color: #fff;
  opacity: 0;
  transition: opacity 0.12s;
}
.cs-pictures li:hover .cs-picture-remove,
.cs-picture-remove:focus-visible {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .cs-picture,
  .cs-picture-remove {
    transition: none;
  }
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
.cs-status-space {
  flex: 1 1 auto;
}
.cs-send-controls {
  display: contents;
}
.cs-pinned .cs-dock,
.cs-pinned .cs-composer {
  grid-template-columns: minmax(0, 1fr);
}
.cs-pinned .cs-composer .cs-compose-actions {
  flex-wrap: wrap;
}
.cs-pinned .cs-status-space {
  display: none;
}
.cs-pinned .cs-composer .cs-status {
  order: 5;
  flex-basis: 100%;
  text-align: left;
}
/* Keep the send controls together and leave room for the ring's overhang. */
.cs-pinned .cs-send-controls {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin-inline-start: auto;
  padding-inline-end: 4px;
}
.cs-send {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
}
.cs-stop {
  flex: none;
  width: 30px;
  height: 30px;
  padding: 0;
}
.cs-stop :deep(svg) {
  fill: currentColor;
}
@container (max-width: 650px) {
  .cs-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .cs-has-selection .cs-sidebar {
    display: none;
  }
  .agent-sessions-app .cs-scheduled-back {
    display: inline-flex;
    align-self: flex-start;
    margin: 8px 10px 0;
  }
  .cs-sidebar {
    border-right: 0;
  }
  .cs-welcome,
  .cs-tiles-empty {
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
  .cs-status-space {
    display: none;
  }
  .cs-stop,
  .cs-send {
    margin-left: auto;
  }
  .cs-user .cs-message-text {
    max-width: 94%;
  }
}
@container (max-width: 420px) {
  .cs-pinned .cs-composer .cs-compose-actions {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content max-content;
  }
  .cs-pinned .cs-compose-actions :deep(.select-trigger.cs-model) {
    width: 100%;
    max-width: 180px;
  }
  .cs-pinned .cs-compose-actions :deep(.cm-pill > span) {
    display: none;
  }
  .cs-pinned .cs-send-controls,
  .cs-pinned .cs-composer .cs-status {
    grid-column: 1 / -1;
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
