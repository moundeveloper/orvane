<script setup lang="ts">
// Test runs app: saved site tests (flows with expect steps) and their runs.
// Tests: each test with its last 10 results; a failed one opens a filmstrip
// of its recorded steps. Map: the pages a run touched, with each test's path
// between them, live while a run works. Replay: a run's recording with its
// steps on a time bar, and the failing step's error, page and screenshot.
// Runs start here (src/flowTestsClient.ts plays them in a Browser task tab)
// or from an AI through flow_tests; both show up live (src/flowTestsLive.ts).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";
import { registerCommands } from "../commands";
import type { Block } from "../model";
import { latestLiveRun, liveRuns } from "../flowTestsLive";
import {
  isRunning, listRuns, listTests, pictureUrl, readRun, runTests,
  type LiveRun, type RunDetail, type RunSummary, type SiteTests,
} from "../flowTestsClient";

const props = defineProps<{ block: Block }>();

type View = "tests" | "map" | "replay";
const view = ref<View>("tests");
const sites = ref<SiteTests[]>([]);
const runs = ref<RunSummary[]>([]);
const site = ref("");
const error = ref("");
const busy = ref(false);
const loaded = ref(false);

async function refresh() {
  try {
    const [t, r] = await Promise.all([listTests(), listRuns()]);
    sites.value = t;
    runs.value = r;
    if (!site.value || !t.some((s) => s.site === site.value)) site.value = t[0]?.site ?? r[0]?.site ?? "";
    error.value = "";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loaded.value = true;
  }
}
onMounted(refresh);
const poll = setInterval(() => {
  if (document.visibilityState === "visible" && !busy.value) void refresh();
}, 5000);
onBeforeUnmount(() => clearInterval(poll));

const current = computed(() => sites.value.find((s) => s.site === site.value));
const tests = computed(() => current.value?.tests.filter((t) => !t.disabled) ?? []);
const siteRuns = computed(() => runs.value.filter((r) => r.site === site.value));
const lastRun = computed(() => siteRuns.value[0]);

// ---- Live ----
const live = computed<(LiveRun & { updatedAt: number }) | undefined>(() => {
  const run = latestLiveRun();
  return run && (!site.value || run.site === site.value) ? run : undefined;
});
const liveCounts = computed(() => {
  const flows = live.value?.flows ?? [];
  return {
    done: flows.filter((f) => f.status === "passed" || f.status === "failed" || f.status === "skipped").length,
    passed: flows.filter((f) => f.status === "passed").length,
    failed: flows.filter((f) => f.status === "failed").length,
    total: flows.length,
  };
});
// A run that ends brings its results in.
watch(
  () => Object.values(liveRuns).map((r) => `${r.runId}:${r.status}`).join(","),
  (now, before) => {
    if (now !== before && Object.values(liveRuns).some((r) => r.status === "done")) void refresh();
  },
);

async function run(input: { names?: string[]; previousRunId?: string } = {}) {
  if (!site.value || isRunning()) return;
  busy.value = true;
  error.value = "";
  view.value = "map";
  try {
    const done = await runTests({ site: site.value, ...input });
    await refresh();
    replayRunId.value = done.runId;
    const failed = done.flows.findIndex((f) => f.status === "failed");
    replayFlow.value = Math.max(0, failed);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

// ---- Tests view ----
const selectedTest = ref("");
const selected = computed(() => tests.value.find((t) => t.name === selectedTest.value));
const selectedRun = ref<RunDetail>();
watch(
  () => selected.value?.history[0]?.runId,
  async (runId) => {
    selectedRun.value = runId ? await readRun(runId).catch(() => undefined) : undefined;
  },
);
const selectedFlow = computed(() => selectedRun.value?.flows.find((f) => f.name === selectedTest.value));
const statusOf = (status?: string) => (status === "passed" ? "ok" : status === "failed" ? "bad" : status ? "skip" : "none");
const ago = (iso?: string) => {
  if (!iso) return "never";
  const at = new Date(iso);
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return days === 0 ? `Today ${time}` : days === 1 ? `Yesterday ${time}` : at.toLocaleDateString();
};
const clock = (ms?: number) => {
  if (ms === undefined) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
function openReplay(runId: string, flowName: string, ms?: number) {
  replayRunId.value = runId;
  pendingReplay = { flowName, ms };
  view.value = "replay";
}

// ---- Replay ----
const replayRunId = ref("");
const replay = ref<RunDetail>();
const replayFlow = ref(0);
const time = ref(0);
const playing = ref(false);
const speed = ref(1);
const detailTab = ref<"error" | "page" | "screenshot">("error");
let pendingReplay: { flowName: string; ms?: number } | undefined;
watch(
  () => [replayRunId.value, view.value] as const,
  async ([runId, v]) => {
    if (v !== "replay") return;
    const id = runId || siteRuns.value[0]?.runId;
    if (!id) return;
    if (replay.value?.runId !== id) replay.value = await readRun(id).catch(() => undefined);
    if (pendingReplay && replay.value) {
      const index = replay.value.flows.findIndex((f) => f.name === pendingReplay!.flowName);
      replayFlow.value = Math.max(0, index);
      time.value = pendingReplay.ms ?? 0;
      pendingReplay = undefined;
    } else if (replay.value && replayFlow.value >= replay.value.flows.length) replayFlow.value = 0;
  },
  { immediate: true },
);
const flow = computed(() => replay.value?.flows[replayFlow.value]);
const duration = computed(() => Math.max(flow.value?.recording?.durationMs ?? 0, flow.value?.durationMs ?? 0, 1));
const frameMs = computed(() => {
  let pick = flow.value?.frames[0] ?? 0;
  for (const ms of flow.value?.frames ?? []) if (ms <= time.value) pick = ms;
  return pick;
});
const currentStep = computed(() => {
  let pick = flow.value?.steps[0];
  for (const s of flow.value?.steps ?? []) if (s.atMs <= time.value + 1) pick = s;
  return pick;
});
watch(flow, () => {
  if (!pendingReplay) time.value = flow.value?.failed?.atMs ?? 0;
  playing.value = false;
});
let player: ReturnType<typeof setInterval> | undefined;
watch(playing, (on) => {
  clearInterval(player);
  if (!on) return;
  if (time.value >= duration.value) time.value = 0;
  let last = performance.now();
  player = setInterval(() => {
    const now = performance.now();
    time.value = Math.min(duration.value, time.value + (now - last) * speed.value);
    last = now;
    if (time.value >= duration.value) playing.value = false;
  }, 50);
});
onBeforeUnmount(() => clearInterval(player));
function stepTo(direction: 1 | -1) {
  const steps = flow.value?.steps ?? [];
  const at = steps.findIndex((s) => s === currentStep.value);
  const next = steps[Math.min(steps.length - 1, Math.max(0, at + direction))];
  if (next) time.value = next.atMs;
}
function seek(event: PointerEvent) {
  const bar = event.currentTarget as HTMLElement;
  const rect = bar.getBoundingClientRect();
  const move = (e: PointerEvent) => (time.value = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * duration.value);
  move(event);
  bar.setPointerCapture(event.pointerId);
  bar.onpointermove = move;
  bar.onpointerup = () => (bar.onpointermove = null);
}
const copied = ref(false);
async function copyForAgent() {
  const f = flow.value;
  if (!f?.failed || !replay.value) return;
  const text = [
    `Test "${f.name}" failed on ${replay.value.site} (run ${replay.value.runId}).`,
    `Step ${f.failed.step} (${f.failed.action}): ${f.steps.find((s) => s.step === f.failed!.step)?.label ?? ""}`,
    `Error: ${f.failed.error}`,
    f.page?.url ? `Page: ${f.page.url}` : "",
    f.page?.text ? `Page text: ${f.page.text.slice(0, 600)}` : "",
    `Use flow_tests failure {runId: "${replay.value.runId}", flow: "${f.name}"} for the screenshot and recorded frame. Decide whether the app, the test, the environment or timing is wrong, fix it, then flow_tests rerun.`,
  ].filter(Boolean).join("\n");
  await navigator.clipboard.writeText(text);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1600);
}

// ---- Map ----
interface MapNode { key: string; label: string; col: number; row: number; status: "ok" | "bad" | "run" | "wait"; touches: number; tests: Set<string>; thumb?: { flow: number; ms: number }; failNote?: string }
const mapSource = computed(() => {
  if (live.value && (live.value.status === "running" || busy.value)) return { kind: "live" as const, run: live.value };
  const id = replayRunId.value || siteRuns.value[0]?.runId;
  return id ? { kind: "saved" as const, id } : undefined;
});
const mapRun = ref<RunDetail>();
watch(
  () => (mapSource.value?.kind === "saved" ? mapSource.value.id : ""),
  async (id) => {
    if (id && mapRun.value?.runId !== id) mapRun.value = await readRun(id).catch(() => undefined);
  },
  { immediate: true },
);
const pattern = (url?: string) => {
  if (!url) return "";
  try {
    const u = new URL(url);
    const keys = [...new Set(u.searchParams.keys())].sort();
    return keys.length ? `${u.pathname}?${keys.join("&")}` : u.pathname;
  } catch {
    return "";
  }
};
const shortPage = (key: string) => {
  const [path] = key.split("?");
  const last = path!.split("/").filter(Boolean).pop() ?? "/";
  return path === "/" ? "/" : last;
};
const map = computed(() => {
  type Flow = { name: string; status: string; steps: { step: number; ok?: boolean; url?: string; atMs?: number }[]; index: number; failedStep?: number; failNote?: string };
  const source = mapSource.value;
  const flows: Flow[] =
    source?.kind === "live"
      ? source.run.flows.map((f, index) => ({ name: f.name, status: f.status, steps: f.steps, index }))
      : (mapRun.value?.flows ?? []).map((f) => ({ name: f.name, status: f.status, steps: f.steps, index: f.index, failedStep: f.failed?.step, failNote: f.failed?.error }));
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, { from: string; to: string; status: string }>();
  const order: string[] = [];
  for (const f of flows) {
    let previous = "";
    let depth = 0;
    for (const s of f.steps) {
      const key = pattern(s.url);
      if (!key) continue;
      if (!nodes.has(key)) {
        nodes.set(key, { key, label: shortPage(key), col: previous ? (nodes.get(previous)!.col + 1) : 0, row: 0, status: "wait", touches: 0, tests: new Set() });
        order.push(key);
      }
      const node = nodes.get(key)!;
      node.touches++;
      node.tests.add(f.name);
      if (s.atMs !== undefined) node.thumb = { flow: f.index, ms: s.atMs + 400 };
      const failedHere = s.ok === false || (f.failedStep !== undefined && s.step === f.failedStep);
      if (failedHere) {
        node.status = "bad";
        node.failNote = f.failNote;
      } else if (s.ok === undefined && f.status === "running") node.status = node.status === "bad" ? "bad" : "run";
      else if (s.ok && node.status === "wait") node.status = "ok";
      if (previous && previous !== key) {
        const id = `${previous}>${key}`;
        const status = f.status === "running" && s.ok === undefined ? "run" : f.status === "failed" && failedHere ? "bad" : s.ok === false ? "bad" : "ok";
        const old = edges.get(id);
        if (!old || status === "run" || (status === "bad" && old.status !== "run")) edges.set(id, { from: previous, to: key, status });
      }
      if (previous !== key) depth++;
      previous = key;
    }
  }
  const rows = new Map<number, number>();
  for (const key of order) {
    const node = nodes.get(key)!;
    node.row = rows.get(node.col) ?? 0;
    rows.set(node.col, node.row + 1);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], flows };
});
const COL = 190, ROW = 128, NODE_W = 140, SHOT_H = 78, PAD = 28;
const nodeAt = (n: MapNode) => ({ x: PAD + 24 + n.col * COL, y: PAD + n.row * ROW });
const mapSize = computed(() => ({
  width: Math.max(...map.value.nodes.map((n) => nodeAt(n).x + NODE_W + PAD), 400),
  height: Math.max(...map.value.nodes.map((n) => nodeAt(n).y + ROW), 300),
}));
const edgePath = (from: string, to: string) => {
  const a = map.value.nodes.find((n) => n.key === from), b = map.value.nodes.find((n) => n.key === to);
  if (!a || !b) return "";
  const p = nodeAt(a), q = nodeAt(b);
  const y1 = p.y + 17 + SHOT_H / 2, y2 = q.y + 17 + SHOT_H / 2;
  if (q.x > p.x) {
    const x1 = p.x + NODE_W, x2 = q.x, mid = (x1 + x2) / 2;
    return `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }
  // Back to an earlier page: around underneath.
  const x1 = p.x + NODE_W / 2, x2 = q.x + NODE_W / 2, low = Math.max(p.y, q.y) + SHOT_H + 44;
  return `M${x1} ${p.y + 17 + SHOT_H} C ${x1} ${low}, ${x2} ${low}, ${x2} ${q.y + 17 + SHOT_H}`;
};
const mapRunId = computed(() => (mapSource.value?.kind === "saved" ? mapRun.value?.runId : undefined));
const latestResult = computed(() => {
  const flows = live.value?.flows.filter((f) => f.status === "passed" || f.status === "failed") ?? [];
  return flows[flows.length - 1];
});

// ---- Keys ----
function onKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, [contenteditable='true']")) return;
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    void run();
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "t") view.value = "tests";
  else if (key === "m") view.value = "map";
  else if (key === "p") view.value = "replay";
  else if (view.value === "tests" && (key === "arrowdown" || key === "arrowup")) {
    event.preventDefault();
    const list = tests.value;
    const at = list.findIndex((t) => t.name === selectedTest.value);
    const next = list[Math.min(list.length - 1, Math.max(0, at + (key === "arrowdown" ? 1 : -1)))];
    if (next) selectedTest.value = next.name;
  } else if (view.value === "tests" && key === "enter" && selected.value?.history[0]) openReplay(selected.value.history[0].runId, selected.value.name);
  else if (view.value === "tests" && key === "r" && selected.value) void run({ names: [selected.value.name] });
  else if (view.value === "replay" && key === " ") {
    event.preventDefault();
    playing.value = !playing.value;
  } else if (view.value === "replay" && key === ",") stepTo(-1);
  else if (view.value === "replay" && key === ".") stepTo(1);
  else if (view.value === "replay" && key === "f" && flow.value?.failed) time.value = flow.value.failed.atMs;
  else return;
}

const stopCommands = registerCommands(`flow-tests:${props.block.id}`, () => [
  { id: `flow-tests-run:${props.block.id}`, title: `Run ${site.value || "site"} tests`, icon: "play", blockId: props.block.id, keywords: "test runs flow tests regression", hint: "Ctrl+Enter", run: () => run() },
  { id: `flow-tests-map:${props.block.id}`, title: "Show the run map", icon: "workflow", blockId: props.block.id, keywords: "test runs", run: () => (view.value = "map") },
  { id: `flow-tests-replay:${props.block.id}`, title: "Replay the last test run", icon: "video", blockId: props.block.id, keywords: "test runs recording", run: () => (view.value = "replay") },
  ...tests.value.map((t) => ({
    id: `flow-tests-test:${props.block.id}:${t.name}`, title: `Run test: ${t.name}`, detail: `Test runs · ${site.value}`, icon: "play", blockId: props.block.id, keywords: "test", run: () => run({ names: [t.name] }),
  })),
]);
onBeforeUnmount(stopCommands);
const root = ref<HTMLElement>();
void nextTick(() => root.value?.focus({ preventScroll: true }));
</script>

<template>
  <div ref="root" class="ft" tabindex="-1" @keydown="onKey">
    <header class="ft-top">
      <div class="ft-row">
        <div class="ft-sites" role="group" aria-label="Site">
          <button v-for="s in sites" :key="s.site" type="button" :aria-pressed="site === s.site" @click="site = s.site">{{ s.site }}</button>
        </div>
        <span class="ft-muted" v-if="lastRun && !live">last run {{ ago(lastRun.startedAt) }} · {{ lastRun.passed }} passed{{ lastRun.failed ? `, ${lastRun.failed} failed` : "" }}</span>
        <span class="ft-grow"></span>
        <div class="ft-seg" role="tablist" aria-label="View">
          <button role="tab" :aria-selected="view === 'tests'" @click="view = 'tests'">Tests</button>
          <button role="tab" :aria-selected="view === 'map'" @click="view = 'map'">Map</button>
          <button role="tab" :aria-selected="view === 'replay'" @click="view = 'replay'">Replay</button>
        </div>
        <button type="button" class="ft-primary" :disabled="!site || busy || !tests.length" @click="run()">
          <Icon name="play" :size="12" />{{ busy ? "Running…" : "Run all" }}<kbd>Ctrl</kbd><kbd>↵</kbd>
        </button>
      </div>
      <div v-if="live" class="ft-prog" :class="{ done: live.status === 'done' }">
        <span class="ft-prog-state">
          <span v-if="live.status === 'running'" class="ft-pulse"></span>
          <Icon v-else name="check" :size="12" />
          {{ live.status === "running" ? `Running · ${live.flows.filter((f) => f.status === "running")[0]?.name ?? ""}` : "Run finished" }}
        </span>
        <div class="ft-bar">
          <i :style="{ width: `${(liveCounts.passed / Math.max(1, liveCounts.total)) * 100}%` }" class="ok"></i>
          <i :style="{ width: `${(liveCounts.failed / Math.max(1, liveCounts.total)) * 100}%` }" class="bad"></i>
        </div>
        <span class="ft-num">{{ liveCounts.done }}/{{ liveCounts.total }}</span>
      </div>
    </header>

    <p v-if="error" class="ft-error" role="alert">{{ error }}</p>

    <!-- Tests -->
    <section v-if="view === 'tests'" class="ft-tests" aria-label="Tests">
      <p v-if="loaded && !tests.length" class="ft-empty">
        No tests yet. Ask an AI to test a site with flow_tests (explore, plan, generate), or save a flow with expect steps in Site memory.
      </p>
      <template v-else>
        <div class="ft-head"><span></span><span>Test</span><span>Last 10</span><span>Ran</span><span>Steps</span><span>Time</span></div>
        <div class="ft-list" role="listbox" aria-label="Tests">
          <template v-for="t in tests" :key="t.name">
            <div
              class="ft-test"
              role="option"
              :aria-selected="selectedTest === t.name"
              :class="statusOf(t.history[0]?.status)"
              @click="selectedTest = selectedTest === t.name ? '' : t.name"
              @dblclick="t.history[0] && openReplay(t.history[0].runId, t.name)"
            >
              <span class="ft-dot" :class="statusOf(t.history[0]?.status)"></span>
              <span class="ft-name">{{ t.name }}<small>{{ t.description }}</small><em v-if="!t.approved">needs approval</em></span>
              <span class="ft-hist"><i v-for="(h, i) in [...t.history].reverse()" :key="i" :class="statusOf(h.status)" :title="`${ago(h.at)} · ${h.status}`"></i></span>
              <span class="ft-when">{{ ago(t.history[0]?.at) }}</span>
              <span class="ft-mono">{{ t.history[0] ? `${t.history[0].failed ? t.history[0].failed.step - 1 : t.history[0].steps}/${t.steps}` : t.steps }}</span>
              <span class="ft-mono">{{ clock(t.history[0]?.durationMs) }}</span>
            </div>
            <div v-if="selectedTest === t.name" class="ft-open" :class="statusOf(t.history[0]?.status)">
              <p v-if="selectedFlow?.failed" class="ft-open-head">
                <strong>Step {{ selectedFlow.failed.step }} · {{ selectedFlow.steps.find((s) => s.step === selectedFlow!.failed!.step)?.label }}</strong>
                <span>{{ selectedFlow.failed.error }}</span>
              </p>
              <p v-else-if="!t.history.length" class="ft-open-head"><span>Not run yet.</span></p>
              <div v-if="selectedFlow && selectedRun && selectedFlow.frames.length" class="ft-strip">
                <button
                  v-for="s in selectedFlow.steps"
                  :key="s.step"
                  type="button"
                  class="ft-frame"
                  :class="{ bad: !s.ok }"
                  :title="s.label"
                  @click="openReplay(selectedRun.runId, t.name, s.atMs)"
                >
                  <img :src="pictureUrl(selectedRun.runId, selectedFlow.index, 'frame', s.atMs + 400)" alt="" loading="lazy" />
                  <span>{{ s.step }} {{ s.action }}</span>
                </button>
              </div>
              <div class="ft-actions">
                <button v-if="t.history[0]" type="button" @click="openReplay(t.history[0].runId, t.name, selectedFlow?.failed?.atMs)">
                  <Icon name="video" :size="13" />Open replay<kbd>↵</kbd>
                </button>
                <button type="button" :disabled="busy" @click="run({ names: [t.name] })"><Icon name="play" :size="12" />Run this test<kbd>R</kbd></button>
                <span class="ft-grow"></span>
                <span v-if="selectedFlow?.recording?.frames" class="ft-muted">{{ selectedFlow.recording.frames }} frame{{ selectedFlow.recording.frames === 1 ? "" : "s" }} recorded</span>
              </div>
            </div>
          </template>
        </div>
      </template>
    </section>

    <!-- Map -->
    <section v-else-if="view === 'map'" class="ft-mapview" aria-label="Run map">
      <div class="ft-map">
        <p v-if="!map.nodes.length" class="ft-empty">{{ busy ? "Opening the site…" : "Run the tests to draw the map of the pages they touch." }}</p>
        <div v-else class="ft-canvas" :style="{ width: `${mapSize.width}px`, height: `${mapSize.height}px` }">
          <svg class="ft-edges" :width="mapSize.width" :height="mapSize.height">
            <path d="" />
            <path v-for="e in map.edges" :key="`${e.from}>${e.to}`" :d="edgePath(e.from, e.to)" :class="e.status" />
          </svg>
          <span class="ft-start" :style="{ top: `${PAD + 17 + SHOT_H / 2 - 4}px` }"></span>
          <div
            v-for="n in map.nodes"
            :key="n.key"
            class="ft-node"
            :class="n.status"
            :style="{ left: `${nodeAt(n).x}px`, top: `${nodeAt(n).y}px` }"
            :title="n.key"
          >
            <div class="ft-node-path">{{ n.label }}</div>
            <button
              type="button"
              class="ft-shot"
              :disabled="!mapRunId || !n.thumb"
              @click="mapRunId && n.thumb && openReplay(mapRunId, map.flows[n.thumb.flow]!.name, n.thumb.ms - 400)"
            >
              <img v-if="mapRunId && n.thumb" :src="pictureUrl(mapRunId, n.thumb.flow, 'frame', n.thumb.ms)" alt="" loading="lazy" />
              <span v-else class="ft-wire"><i class="h"></i><i></i><i class="s"></i><i class="g"></i></span>
              <span v-if="n.status === 'ok'" class="ft-badge ok"><Icon name="check" :size="10" /></span>
              <span v-else-if="n.status === 'bad'" class="ft-badge bad"><Icon name="close" :size="10" /></span>
            </button>
            <div class="ft-node-note" :class="{ bad: n.status === 'bad' }">
              {{ n.status === "bad" ? "failed here" : n.status === "run" ? "running" : `${n.tests.size} test${n.tests.size === 1 ? "" : "s"} · ${n.touches} touches` }}
            </div>
          </div>
        </div>
        <div v-if="latestResult && live" class="ft-toast" :class="statusOf(latestResult.status)">
          <Icon :name="latestResult.status === 'passed' ? 'check' : 'close'" :size="13" />{{ latestResult.name }}<span>{{ latestResult.status }}</span>
        </div>
      </div>
      <aside class="ft-side" aria-label="Run">
        <div class="ft-side-head"><strong>{{ live && mapSource?.kind === "live" ? "This run" : "Last run" }}</strong><span class="ft-muted">{{ map.flows.length }} tests</span></div>
        <div class="ft-side-list">
          <div v-for="f in map.flows" :key="f.name" class="ft-side-flow">
            <div class="ft-side-title">
              <span class="ft-dot" :class="f.status === 'running' ? 'run' : statusOf(f.status === 'queued' ? '' : f.status)"></span>
              <span>{{ f.name }}</span>
            </div>
            <ol v-if="f.status === 'running' || f.status === 'failed'" class="ft-side-steps">
              <li v-for="s in (mapSource?.kind === 'live' ? live!.flows.find((x) => x.name === f.name)?.steps : mapRun?.flows.find((x) => x.name === f.name)?.steps) ?? []" :key="s.step" :class="s.ok === undefined ? 'run' : s.ok ? 'ok' : 'bad'">
                {{ s.label }}
              </li>
            </ol>
            <p v-if="f.failNote" class="ft-side-fail">{{ f.failNote }}</p>
          </div>
        </div>
      </aside>
    </section>

    <!-- Replay -->
    <section v-else class="ft-replay" aria-label="Replay">
      <p v-if="!replay" class="ft-empty">No run to replay yet.</p>
      <template v-else>
        <div class="ft-left">
          <div class="ft-rtop">
            <div class="ft-seg" role="tablist" aria-label="Test">
              <button v-for="(f, i) in replay.flows" :key="f.name" role="tab" :aria-selected="replayFlow === i" :class="statusOf(f.status)" @click="replayFlow = i">
                <span class="ft-dot" :class="statusOf(f.status)"></span>{{ f.name }}
              </button>
            </div>
            <span class="ft-grow"></span>
            <span class="ft-muted">{{ ago(replay.startedAt) }} · {{ replay.by === "app" ? "run here" : "run by an AI" }}</span>
            <button type="button" class="ft-ghost" :disabled="busy" @click="run({ names: replay.flows.map((f) => f.name), previousRunId: replay.runId })">
              <Icon name="refresh" :size="12" />Run again
            </button>
          </div>
          <div class="ft-video">
            <img v-if="flow && flow.frames.length" :key="`${replay.runId}:${replayFlow}:${frameMs}`" :src="pictureUrl(replay.runId, flow.index, 'frame', frameMs)" alt="Recorded frame" />
            <p v-else class="ft-empty">{{ flow?.recording?.warning ?? "This test was not recorded." }}</p>
            <div v-if="currentStep" class="ft-cap" :class="{ bad: !currentStep.ok }">
              <Icon :name="currentStep.ok ? 'check' : 'close'" :size="12" />#{{ currentStep.step }} {{ currentStep.label }}
            </div>
          </div>
          <div class="ft-ctrl">
            <div class="ft-track" role="slider" aria-label="Time" :aria-valuenow="Math.round(time)" :aria-valuemax="duration" @pointerdown="seek">
              <div class="ft-rail"></div>
              <div class="ft-fill" :style="{ width: `${(time / duration) * 100}%` }"></div>
              <span v-for="s in flow?.steps ?? []" :key="s.step" class="ft-tick" :class="{ bad: !s.ok }" :style="{ left: `${(s.atMs / duration) * 100}%` }"></span>
              <span class="ft-knob" :class="{ bad: currentStep && !currentStep.ok }" :style="{ left: `${(time / duration) * 100}%` }"></span>
            </div>
            <div class="ft-row">
              <button type="button" class="ft-play" :aria-label="playing ? 'Pause' : 'Play'" @click="playing = !playing"><Icon :name="playing ? 'stop' : 'play'" :size="12" /></button>
              <span class="ft-num">{{ clock(time) }} / {{ clock(duration) }}</span>
              <button type="button" class="ft-pill" @click="speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1">{{ speed }}×</button>
              <span class="ft-pill" v-if="currentStep">Step {{ currentStep.step }} of {{ flow?.steps.length }}</span>
              <span class="ft-grow"></span>
              <span class="ft-keys"><kbd>Space</kbd> play <kbd>,</kbd><kbd>.</kbd> step <kbd>F</kbd> failure</span>
            </div>
          </div>
        </div>
        <aside class="ft-steps" aria-label="Steps">
          <div class="ft-side-head">
            <strong>Steps</strong>
            <span class="ft-muted">{{ flow?.steps.filter((s) => s.ok).length }} passed{{ flow?.failed ? " · 1 failed" : "" }}</span>
          </div>
          <div class="ft-step-list" role="listbox">
            <template v-for="s in flow?.steps ?? []" :key="s.step">
              <button type="button" role="option" class="ft-step" :aria-selected="currentStep?.step === s.step" :class="{ bad: !s.ok }" @click="time = s.atMs">
                <Icon :name="s.ok ? 'check' : 'close'" :size="12" />
                <span class="ft-act">{{ s.action }}</span>
                <span class="ft-label">{{ s.label.replace(new RegExp(`^${s.action}\\s*`), "") }}</span>
                <span class="ft-num">{{ clock(s.atMs) }}</span>
              </button>
              <div v-if="!s.ok && flow?.failed" class="ft-detail">
                <div class="ft-seg small" role="tablist">
                  <button role="tab" :aria-selected="detailTab === 'error'" @click="detailTab = 'error'">Error</button>
                  <button role="tab" :aria-selected="detailTab === 'page'" @click="detailTab = 'page'">Page</button>
                  <button role="tab" :aria-selected="detailTab === 'screenshot'" :disabled="!flow.hasScreenshot" @click="detailTab = 'screenshot'">Screenshot</button>
                </div>
                <p v-if="detailTab === 'error'">{{ flow.failed.error }}</p>
                <div v-else-if="detailTab === 'page'" class="ft-page">
                  <code>{{ flow.page?.url }}</code>
                  <p>{{ flow.page?.text?.slice(0, 500) }}</p>
                </div>
                <img v-else class="ft-shot-full" :src="pictureUrl(replay.runId, flow.index, 'screenshot')" alt="Failure screenshot" />
                <div class="ft-actions">
                  <button type="button" class="ft-primary" @click="copyForAgent"><Icon name="copy" :size="12" />{{ copied ? "Copied" : "Copy for an agent" }}</button>
                </div>
              </div>
            </template>
          </div>
        </aside>
      </template>
    </section>
  </div>
</template>

<style scoped>
.ft {
  --strong: #273f50; --text: #455968; --muted: #5d7381; --faint: #8296a2; --accent: #6f8998; --run: #365f78;
  --link: #385d76; --ok: #4f7d5f; --fail: #a0624f; --line: #e3eaee; --border: #dbe5eb; --pop: #d3dee5;
  --chip: #e6eef3; --hover: #eef3f6; --mono: "Cascadia Code", Consolas, monospace;
  display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; color: var(--text); font-size: 13px; outline: none;
}
.ft-top { display: grid; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.ft-row { display: flex; align-items: center; gap: 9px; min-width: 0; }
.ft-row strong { color: var(--strong); font-weight: 600; }
.ft-mark { color: var(--accent); }
.ft-grow { flex: 1; }
.ft-muted { color: var(--faint); font-size: 12px; white-space: nowrap; }
.ft-sites { display: flex; gap: 4px; overflow: hidden; }
.ft-sites button { height: 22px; padding: 0 8px; border-radius: 6px; background: var(--chip); color: var(--link); font: 11.5px var(--mono); }
.ft-sites button[aria-pressed="false"] { background: transparent; color: var(--faint); }
.ft-seg { display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: #e8eff3; }
.ft-seg button { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 5px; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.ft-seg button[aria-selected="true"] { background: #fbfcfd; color: var(--strong); box-shadow: 0 1px 2px #263f5512; }
.ft-seg.small button { height: 22px; }
kbd { display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px; border: 1px solid #d6e0e6; border-bottom-width: 2px; border-radius: 4px; background: #fbfcfd; font: 10px/1 var(--mono); color: var(--muted); }
.ft-primary { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 7px; background: var(--run); color: #fff; font-size: 12px; }
.ft-primary kbd { background: transparent; border-color: #ffffff55; color: #ffffffcc; }
.ft-primary:disabled { opacity: 0.5; }
.ft-ghost, .ft-actions button:not(.ft-primary) { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border: 1px solid var(--pop); border-radius: 7px; background: #fbfcfd; font-size: 12px; color: var(--text); }
.ft-ghost:hover, .ft-actions button:not(.ft-primary):hover { background: var(--hover); }
.ft-prog { display: flex; align-items: center; gap: 10px; }
.ft-prog-state { display: inline-flex; align-items: center; gap: 7px; min-width: 200px; font-size: 12px; color: var(--run); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-prog.done .ft-prog-state { color: var(--ok); }
.ft-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--run); animation: ft-pulse 1.4s ease-in-out infinite; }
@keyframes ft-pulse { 50% { opacity: 0.35; } }
.ft-bar { flex: 1; height: 4px; border-radius: 2px; background: #dfe7ec; display: flex; overflow: hidden; gap: 1px; }
.ft-bar i { display: block; height: 100%; transition: width 0.2s ease; }
.ft-bar i.ok { background: var(--ok); }
.ft-bar i.bad { background: var(--fail); }
.ft-num { font: 11.5px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ft-mono { font: 11.5px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.ft-error { margin: 8px 14px 0; color: #9a4b45; font-size: 12px; }
.ft-empty { margin: 24px; color: var(--faint); font-size: 12.5px; line-height: 1.6; max-width: 62ch; }

/* Tests */
.ft-tests { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.ft-head, .ft-test { display: grid; grid-template-columns: 16px 1fr 92px 110px 56px 52px; align-items: center; gap: 10px; }
.ft-head { height: 30px; padding: 0 22px; border-bottom: 1px solid var(--line); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: #7a8f9b; }
.ft-list { overflow: auto; padding: 4px 8px 8px; flex: 1; }
.ft-test { height: 38px; padding: 0 14px; border-radius: 6px; cursor: pointer; }
.ft-test:hover { background: var(--hover); }
.ft-test[aria-selected="true"] { background: #e4edf2; }
.ft-test[aria-selected="true"].bad { background: #f6ebe7; }
.ft-dot { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid #b5c3cc; flex: none; }
.ft-dot.ok { background: var(--ok); border-color: var(--ok); }
.ft-dot.bad { background: var(--fail); border-color: var(--fail); }
.ft-dot.run { border-color: var(--run); box-shadow: 0 0 0 3px #365f781a; }
.ft-name { color: var(--strong); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-name small { margin-left: 6px; color: var(--faint); font-weight: 400; font-size: 12px; }
.ft-name em { margin-left: 6px; font-style: normal; font-size: 10.5px; color: #8a6d2c; }
.ft-hist { display: flex; gap: 2px; }
.ft-hist i { width: 5px; height: 14px; border-radius: 2px; background: #dfe7ec; }
.ft-hist i.ok { background: #9fbfa9; }
.ft-hist i.bad { background: #d29c8c; }
.ft-when { font-size: 12px; color: var(--faint); }
.ft-open { margin: 2px 8px 8px 30px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: #f7fafb; display: grid; gap: 8px; }
.ft-open.bad { border-color: #ead7cf; background: #fdf9f7; }
.ft-open-head { margin: 0; display: grid; gap: 2px; font-size: 12px; }
.ft-open-head strong { color: var(--strong); font-weight: 550; }
.ft-open-head span { color: var(--fail); }
.ft-strip { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
.ft-frame { width: 104px; flex: none; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: #fff; padding: 0; text-align: left; }
.ft-frame:hover { border-color: #9fb6c3; }
.ft-frame.bad { border: 1.5px solid var(--fail); box-shadow: 0 0 0 3px #a0624f1a; }
.ft-frame img { display: block; width: 100%; height: 58px; object-fit: cover; object-position: top; background: #f4f7f9; }
.ft-frame span { display: block; height: 20px; padding: 0 6px; font: 10px/20px var(--mono); color: var(--muted); border-top: 1px solid var(--line); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-frame.bad span { color: var(--fail); }
.ft-actions { display: flex; align-items: center; gap: 8px; }

/* Map */
.ft-mapview { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 280px; }
.ft-map { position: relative; overflow: auto; background-image: radial-gradient(#d3dee5 1px, transparent 1px); background-size: 16px 16px; background-color: #f4f7f9; border-right: 1px solid var(--line); }
.ft-canvas { position: relative; }
.ft-edges { position: absolute; inset: 0; }
.ft-edges path { fill: none; stroke: #b9cad4; stroke-width: 1.3; }
.ft-edges path.ok { stroke: #9fbfa9; }
.ft-edges path.bad { stroke: #d29c8c; }
.ft-edges path.run { stroke: var(--run); stroke-width: 1.6; stroke-dasharray: 5 4; animation: ft-dash 0.9s linear infinite; }
@keyframes ft-dash { to { stroke-dashoffset: -18; } }
.ft-start { position: absolute; left: 22px; width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid var(--accent); background: #fff; }
.ft-node { position: absolute; width: 140px; }
.ft-node-path { font: 10.5px var(--mono); color: var(--muted); margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-shot { position: relative; display: block; width: 140px; height: 78px; padding: 0; border-radius: 7px; border: 1px solid var(--border); background: #fff; box-shadow: 0 1px 2px #263f5512; overflow: hidden; }
.ft-shot img { width: 100%; height: 100%; object-fit: cover; object-position: top left; }
.ft-node.run .ft-shot { border-color: #9fb6c3; box-shadow: 0 0 0 3px #6f89981f; }
.ft-node.bad .ft-shot { border-color: #e0b8ab; }
.ft-node.wait .ft-shot { opacity: 0.6; }
.ft-wire { display: grid; gap: 4px; padding: 8px; }
.ft-wire i { display: block; height: 4px; border-radius: 2px; background: #e4ebef; }
.ft-wire i.h { height: 7px; width: 52%; background: #cfdae1; }
.ft-wire i.s { width: 68%; }
.ft-wire i.g { height: 14px; background: #eef3f6; }
.ft-badge { position: absolute; right: 6px; bottom: 6px; width: 16px; height: 16px; border-radius: 5px; display: grid; place-items: center; color: #fff; }
.ft-badge.ok { background: var(--ok); }
.ft-badge.bad { background: var(--fail); }
.ft-node-note { margin-top: 3px; font-size: 10.5px; color: var(--faint); white-space: nowrap; }
.ft-node-note.bad { color: var(--fail); }
.ft-toast { position: sticky; left: 50%; bottom: 14px; transform: translateX(-50%); display: inline-flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; margin-top: -44px; border-radius: 8px; background: rgb(247 250 252 / 85%); backdrop-filter: blur(8px) saturate(120%); border: 1px solid #ffffffa3; box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526; color: var(--strong); font-size: 12px; white-space: nowrap; }
.ft-toast.ok svg { color: var(--ok); }
.ft-toast.bad svg { color: var(--fail); }
.ft-toast span { color: var(--faint); }
.ft-side { display: flex; flex-direction: column; min-height: 0; }
.ft-side-head { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; flex: none; }
.ft-side-head strong { color: var(--strong); font-weight: 600; }
.ft-side-list { overflow: auto; padding: 0 12px 12px; display: grid; gap: 8px; align-content: start; }
.ft-side-flow { display: grid; gap: 4px; }
.ft-side-title { display: flex; align-items: center; gap: 8px; color: var(--strong); font-size: 12.5px; font-weight: 500; }
.ft-side-steps { margin: 0; padding-left: 26px; display: grid; gap: 2px; font: 11px/1.5 var(--mono); color: var(--muted); }
.ft-side-steps li.run { color: var(--run); }
.ft-side-steps li.bad { color: var(--fail); }
.ft-side-fail { margin: 0 0 0 17px; padding: 6px 8px; border: 1px solid #ead7cf; border-radius: 6px; background: #fdf9f7; color: var(--fail); font-size: 11.5px; }

/* Replay */
.ft-replay { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 320px; }
.ft-left { display: grid; grid-template-rows: auto 1fr auto; gap: 10px; padding: 12px 14px; min-height: 0; min-width: 0; border-right: 1px solid var(--line); }
.ft-rtop { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ft-rtop .ft-seg { overflow-x: auto; max-width: 60%; }
.ft-seg button.bad[aria-selected="true"] { color: #7b3b2d; }
.ft-video { position: relative; min-height: 0; border-radius: 8px; overflow: hidden; background: #fff; border: 1px solid var(--border); display: grid; place-items: center; }
.ft-video img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; object-position: top center; }
.ft-cap { position: absolute; left: 10px; bottom: 10px; display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 9px; border-radius: 7px; background: rgb(247 250 252 / 85%); backdrop-filter: blur(8px) saturate(120%); box-shadow: 0 4px 12px #263f5518; font-size: 11.5px; color: var(--strong); max-width: calc(100% - 20px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-cap svg { color: var(--ok); }
.ft-cap.bad svg { color: var(--fail); }
.ft-ctrl { display: grid; gap: 7px; }
.ft-track { position: relative; height: 22px; cursor: pointer; touch-action: none; }
.ft-rail { position: absolute; left: 0; right: 0; top: 10px; height: 3px; border-radius: 2px; background: #d3dee5; }
.ft-fill { position: absolute; left: 0; top: 10px; height: 3px; border-radius: 2px; background: var(--run); }
.ft-tick { position: absolute; top: 6px; width: 3px; height: 11px; margin-left: -1px; border-radius: 2px; background: var(--ok); }
.ft-tick.bad { background: var(--fail); height: 13px; top: 5px; }
.ft-knob { position: absolute; top: 4px; width: 15px; height: 15px; margin-left: -7px; border-radius: 50%; background: #fff; border: 1.5px solid var(--run); box-shadow: 0 1px 3px #263f5530; }
.ft-knob.bad { border: 2px solid var(--fail); box-shadow: 0 0 0 3px #a0624f22, 0 1px 3px #263f5530; }
.ft-play { width: 28px; height: 28px; border-radius: 8px; background: var(--run); color: #fff; display: grid; place-items: center; }
.ft-pill { height: 24px; padding: 0 8px; border-radius: 7px; background: var(--chip); color: var(--link); font: 11px var(--mono); display: inline-flex; align-items: center; }
.ft-keys { display: inline-flex; align-items: center; gap: 4px; color: var(--faint); font-size: 11.5px; white-space: nowrap; }
.ft-steps { display: flex; flex-direction: column; min-height: 0; }
.ft-step-list { overflow: auto; padding: 0 8px 10px; }
.ft-step { display: grid; grid-template-columns: 14px 50px 1fr auto; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px; border-radius: 6px; text-align: left; font-size: 12.5px; color: var(--text); }
.ft-step:hover { background: var(--hover); }
.ft-step svg { color: var(--ok); }
.ft-step.bad svg { color: var(--fail); }
.ft-step[aria-selected="true"] { background: #e4edf2; }
.ft-step.bad[aria-selected="true"], .ft-step.bad { background: #f6ebe7; }
.ft-act { font: 11px var(--mono); color: var(--muted); }
.ft-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ft-step[aria-selected="true"] .ft-label { color: var(--strong); font-weight: 550; }
.ft-detail { margin: 4px 4px 8px 30px; padding: 8px 10px; border: 1px solid #ead7cf; border-radius: 8px; background: #fdf9f7; display: grid; gap: 8px; font-size: 12px; }
.ft-detail p { margin: 0; line-height: 1.55; }
.ft-page code { font: 11px var(--mono); color: var(--link); word-break: break-all; }
.ft-page p { color: var(--muted); font-size: 11.5px; max-height: 120px; overflow: auto; }
.ft-shot-full { width: 100%; border-radius: 6px; border: 1px solid var(--line); }
.ft-list::-webkit-scrollbar, .ft-step-list::-webkit-scrollbar, .ft-side-list::-webkit-scrollbar, .ft-map::-webkit-scrollbar, .ft-strip::-webkit-scrollbar { width: 6px; height: 6px; }
.ft-list::-webkit-scrollbar-thumb, .ft-step-list::-webkit-scrollbar-thumb, .ft-side-list::-webkit-scrollbar-thumb, .ft-map::-webkit-scrollbar-thumb, .ft-strip::-webkit-scrollbar-thumb { background: #c9d5dc; border-radius: 3px; }
@media (prefers-reduced-motion: reduce) {
  .ft-pulse, .ft-edges path.run { animation: none; }
  .ft-bar i { transition: none; }
}
</style>
