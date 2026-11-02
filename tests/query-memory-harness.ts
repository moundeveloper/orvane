import { createApp, h, isReactive, reactive } from "vue";
import Query from "../src/components/NetSuiteQuery.vue";
import { QueryOutputCache, queryOutputBudget } from "../src/queryOutputs";
import type { Block } from "../src/model";

type Entry = {
  owner: QueryOutputCache<any>;
  id: string;
  bytes: number;
  rows: number;
  reactiveRows: number;
  reactiveArray: boolean;
  traceStages: number;
  reactiveStages: number;
  reactiveTraceRows: number;
};
export function mountQueryMemoryFixture(
  tabCount = 20,
  rowCount = 100,
  cellSize = 1024,
  budgetBytes?: number,
  viewCount = 1,
) {
  const previousBudget = queryOutputBudget.limit;
  if (budgetBytes !== undefined) queryOutputBudget.setLimit(budgetBytes);
  const files = reactive(
    Array.from({ length: tabCount }, (_, i) => ({
      id: `query-${i}`,
      name: `Query ${i}`,
      sql: `SELECT id, memo FROM fixture_${i}`,
    })),
  );
  const blocks = Array.from(
    { length: viewCount },
    (_, i) =>
      reactive({
        id: `memory-queries-${i}`,
        kind: "netsuite",
        value: JSON.stringify({
          queryTabs: {
            fixture: {
              open: files.map((file) => file.id),
              active: files[0]!.id,
            },
          },
        }),
      }) as unknown as Block,
  );
  const root = document.createElement("div");
  root.id = "query-memory-fixture";
  root.style.cssText =
    "position:fixed;inset:0;z-index:999999;background:#f7f9fa;font-size:12px;display:flex;flex-direction:column";
  document.body.appendChild(root);
  const outputs = new Map<string, Entry>(),
    owners = new WeakMap<object, number>();
  let ownerCount = 0;
  const key = (owner: object, id: string) => {
    if (!owners.has(owner)) owners.set(owner, ++ownerCount);
    return `${owners.get(owner)}:${id}`;
  };
  const saves = QueryOutputCache.prototype.save,
    takes = QueryOutputCache.prototype.take,
    deletes = QueryOutputCache.prototype.delete,
    clears = QueryOutputCache.prototype.clear,
    retains = QueryOutputCache.prototype.retain;
  const writes: { sql?: string; offset?: number }[] = [];
  const stringify = JSON.stringify;
  let formattedRowSerializations = 0;
  JSON.stringify = function (value: any, ...args: any[]) {
    if (Array.isArray(value) && typeof value[0]?.memo === "string")
      formattedRowSerializations++;
    return (stringify as any)(value, ...args);
  } as typeof JSON.stringify;
  let deferredAt = 0,
    complete: (() => void) | undefined;
  QueryOutputCache.prototype.save = function (id: string, output: any) {
    const saved = saves.call(this, id, output);
    if (saved)
      outputs.set(key(this, id), {
        owner: this,
        id,
        bytes: new TextEncoder().encode(JSON.stringify(output)).byteLength,
        rows: output.rows.length,
        reactiveRows: output.rows.filter(isReactive).length,
        reactiveArray: isReactive(output.rows),
        traceStages: output.trace?.stages.length ?? 0,
        reactiveStages: output.trace?.stages.filter(isReactive).length ?? 0,
        reactiveTraceRows:
          output.trace?.stages
            .flatMap((stage: any) => stage.rows)
            .filter(isReactive).length ?? 0,
      });
    return saved;
  };
  QueryOutputCache.prototype.take = function (id: string) {
    const value = takes.call(this, id);
    outputs.delete(key(this, id));
    return value;
  };
  QueryOutputCache.prototype.delete = function (id: string) {
    deletes.call(this, id);
    outputs.delete(key(this, id));
  };
  QueryOutputCache.prototype.clear = function () {
    clears.call(this);
    for (const [id, entry] of outputs)
      if (entry.owner === this) outputs.delete(id);
  };
  QueryOutputCache.prototype.retain = function (ids: Iterable<string>) {
    const allowed = [...ids];
    retains.call(this, allowed);
    for (const [id, entry] of outputs)
      if (entry.owner === this && !allowed.includes(entry.id))
        outputs.delete(id);
  };
  const request = async (operation: string, args: Record<string, any> = {}) => {
    if (operation !== "query") return { data: [], rows: [] };
    writes.push({ sql: args.sql, offset: args.offset });
    if (writes.length === deferredAt)
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    return {
      rows: Array.from({ length: rowCount }, (_, i) => ({
        id: i + 1,
        memo: `${args.sql}:row-${i}:${"x".repeat(cellSize)}`,
        active: i % 2 === 0,
        amount: i * 1.5,
      })),
      totalCount: rowCount * 3,
      offset: args.offset ?? 0,
    };
  };
  const render = (i: number) =>
    h(Query, {
      class: "query-memory-panel",
      style: "min-width:0",
      block: blocks[i]!,
      environment: "fixture",
      stateKey: "fixture",
      files,
      request,
      openRecord: () => {},
    });
  const app = createApp({
    render: () =>
      viewCount === 1
        ? render(0)
        : h(
            "div",
            { style: "display:flex;height:100%;gap:8px" },
            blocks.map((_, i) => render(i)),
          ),
  });
  app.mount(root);
  return {
    get stats() {
      const entries = [...outputs.values()].filter(
        (entry) => !entry.owner.wasEvicted(entry.id),
      );
      return {
        cachedTabs: entries.length,
        rows: entries.reduce((sum, entry) => sum + entry.rows, 0),
        reactiveRows: entries.reduce(
          (sum, entry) => sum + entry.reactiveRows,
          0,
        ),
        reactiveArrays: entries.filter((entry) => entry.reactiveArray).length,
        traceStages: entries.reduce((sum, entry) => sum + entry.traceStages, 0),
        reactiveStages: entries.reduce(
          (sum, entry) => sum + entry.reactiveStages,
          0,
        ),
        reactiveTraceRows: entries.reduce(
          (sum, entry) => sum + entry.reactiveTraceRows,
          0,
        ),
        serializedOutputBytes: entries.reduce(
          (sum, entry) => sum + entry.bytes,
          0,
        ),
        queryRequests: writes.length,
        accountedCacheBytes: queryOutputBudget.bytes,
        budgetBytes: queryOutputBudget.limit,
        formattedRowSerializations,
      };
    },
    deferQueryAt(index: number) {
      deferredAt = index;
    },
    complete() {
      complete?.();
      complete = undefined;
    },
    setBudget(bytes: number) {
      queryOutputBudget.setLimit(bytes);
    },
    unmount() {
      app.unmount();
      root.remove();
      outputs.clear();
      QueryOutputCache.prototype.save = saves;
      QueryOutputCache.prototype.take = takes;
      QueryOutputCache.prototype.delete = deletes;
      QueryOutputCache.prototype.clear = clears;
      QueryOutputCache.prototype.retain = retains;
      queryOutputBudget.setLimit(previousBudget);
      JSON.stringify = stringify;
    },
  };
}
