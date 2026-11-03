// Research only: installed Notes request path, mocked local transport.
// Run: node --import tsx research/notes-fanout.ts
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createPinia, setActivePinia, disposePinia } from 'pinia';
import { createWorkspaceStore } from '../src/components/notes/stores/workspace.ts';

const originalFetch = globalThis.fetch;
const results = [];
try {
  for (const count of [5, 20, 50]) {
    const pinia = createPinia(); setActivePinia(pinia);
    const stores = Array.from({ length: count }, (_, i) => createWorkspaceStore(`fanout-${i}`));
    let requests = 0, active = 0, maxConcurrent = 0;
    globalThis.fetch = async () => {
      requests++; active++; maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const started = performance.now();
    // NotesView's pages:true change handler skips the source instance and
    // calls refreshPages on each remaining store. Exercise those exact reads.
    await Promise.all(stores.slice(1).map(store => store.refreshPages()));
    results.push({ notesApps: count, requestsForOnePagesEvent: requests, maxConcurrent,
      elapsedWithArtificial2msService: Number((performance.now() - started).toFixed(2)) });
    stores.forEach(store => store.$dispose());
    disposePinia(pinia);
  }
} finally {
  globalThis.fetch = originalFetch;
}
const report = { baseline: 'a5143f4', context: 'Real Notes store/request functions; mocked transport, no UI and no live database', results };
writeFileSync(new URL('./notes-fanout-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
