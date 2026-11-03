// Research only: isolated Node measurements of installed application code.
// Run: node --import tsx research/scaling.ts
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { reactive, watch } from 'vue';
import { createPinia, setActivePinia, disposePinia } from 'pinia';
import { emptyWorkspace, makeBlock, uid, type CanvasApp } from '../src/model.ts';
import { parseWorkspace } from '../src/validation.ts';
import { createWorkspaceStore } from '../src/components/notes/stores/workspace.ts';

const percentile = (samples: number[], q: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(3));
};
function fixture(count: number) {
  const workspace = emptyWorkspace();
  workspace.apps = Array.from({ length: count }, (_, i): CanvasApp => ({
    id: uid(), name: `Research ${i}`, icon: 'app', x: i * 650, y: 100,
    width: 600, height: 500, archived: false, group: '', exposed: false,
    accent: '#6f8998', padding: 24, gap: 12, radius: 8,
    blocks: Array.from({ length: 10 }, (_, b) => {
      const block = makeBlock(b % 2 ? 'text' : 'list');
      if (block.kind === 'list') block.items = Array.from({ length: 40 }, (_, j) => ({ id: uid(), text: `Item ${j}`, done: false }));
      else block.value = 'Research content '.repeat(20);
      return block;
    }),
  }));
  return workspace;
}
const scaling = [];
for (const count of [5, 20, 50]) {
  const raw = fixture(count);
  const wire = JSON.stringify(raw);
  const samples: Record<string, number[]> = { serializeReactive: [], parseValidate: [], mutationSyncWatch: [], mutationPausedWatch: [], resumePausedWatch: [], mutationPerAppWatch: [] };
  const w = reactive(raw);
  let callbacks = 0;
  const handle = watch(w, () => callbacks++, { deep: true, flush: 'sync' });
  const counts: Record<string, number> = {};
  // Warm up before five measured repetitions; individual results are diagnostics,
  // not foreground frame latency or desktop performance guarantees.
  JSON.stringify(w); parseWorkspace(JSON.parse(wire), wire.length);
  for (let repeat = 0; repeat < 5; repeat++) {
    let started = performance.now(); JSON.stringify(w);
    samples.serializeReactive!.push(performance.now() - started);
    started = performance.now(); parseWorkspace(JSON.parse(wire), wire.length);
    samples.parseValidate!.push(performance.now() - started);
    for (const paused of [false, true]) {
      callbacks = 0;
      started = performance.now();
      if (paused) handle.pause();
      for (let move = 0; move < 25; move++) { w.apps[0]!.x++; w.apps[0]!.y++; }
      if (paused) {
        const resumeStarted = performance.now();
        handle.resume();
        samples.resumePausedWatch!.push(performance.now() - resumeStarted);
      }
      const name = paused ? 'mutationPausedWatch' : 'mutationSyncWatch';
      samples[name]!.push((performance.now() - started) / 25);
      counts[name] = callbacks;
    }
  }
  handle.stop();
  // Candidate only: 50 scoped subscriptions rather than one workspace traversal.
  // It needs production revision/atomicity tests before it can replace anything.
  const scoped = w.apps.map(app => watch(app, () => callbacks++, { deep: true, flush: 'sync' }));
  for (let repeat = 0; repeat < 5; repeat++) {
    callbacks = 0;
    const started = performance.now();
    for (let move = 0; move < 25; move++) { w.apps[0]!.x++; w.apps[0]!.y++; }
    samples.mutationPerAppWatch!.push((performance.now() - started) / 25);
    counts.mutationPerAppWatch = callbacks;
  }
  scoped.forEach(stop => stop());
  scaling.push({ count, blocksPerApp: 10, listItemsPerApp: 200, bytes: Buffer.byteLength(wire),
    timingsMs: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, { p50: percentile(values, .5), max: percentile(values, 1) }])),
    watcherCallbacksPer25Moves: counts });
}

// Exercise the actual Notes factory and teardown call, with no database requests.
const pinia = createPinia(); setActivePinia(pinia);
const disposed: string[] = [];
for (let i = 0; i < 50; i++) {
  const store = createWorkspaceStore(`research-${i}`);
  // A sentinel avoids inventing Notes records or invoking persistence.
  store.$state.recentIds = [`sentinel-${i}`];
  disposed.push(store.$id);
  store.$dispose();
}
const retainedAfterDispose = disposed.filter(id => id in pinia.state.value).length;
for (const id of disposed) delete pinia.state.value[id];
const retainedAfterExplicitDelete = disposed.filter(id => id in pinia.state.value).length;
disposePinia(pinia);
const result = { baseline: 'a5143f4', context: 'Node isolated diagnostic, not UI or network timing', node: process.version,
  scaling, notesDisposal: { storesCreatedAndDisposed: 50, retainedAfterDispose, retainedAfterExplicitDelete } };
writeFileSync(new URL('./scaling-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
