import test from "node:test";
import assert from "node:assert/strict";
import { QueryOutputCache } from "../src/queryOutputs.ts";

test("50 closed query outputs are released and late transitions cannot restore them", () => {
  const cache = new QueryOutputCache<{
    rows: { value: string }[];
    trace: { rows: { value: string }[] };
  }>();
  const ids = Array.from({ length: 50 }, (_, i) => `query-${i}`);
  cache.retain(ids);
  for (const id of ids)
    assert.equal(
      cache.save(id, {
        rows: [{ value: "result".repeat(1000) }],
        trace: { rows: [{ value: "trace".repeat(1000) }] },
      }),
      true,
    );
  assert.equal(cache.size, 50);
  cache.retain([ids[49]!]);
  assert.equal(cache.size, 1);
  assert.equal(cache.save(ids[0]!, { rows: [], trace: { rows: [] } }), false);
  cache.retain([]);
  assert.equal(cache.size, 0);
  assert.equal(cache.take(ids[49]!), undefined);
  cache.retain(ids);
  assert.equal(cache.take(ids[0]!), undefined);
});

test("activating output transfers ownership without cloning or retaining an obsolete snapshot", () => {
  const cache = new QueryOutputCache<{ rows: number[] }>();
  cache.retain(["a", "b"]);
  const original = { rows: [1, 2, 3] };
  cache.save("a", original);
  assert.equal(cache.take("a"), original);
  assert.equal(cache.size, 0);
  assert.equal(cache.take("a"), undefined);
  cache.save("a", { rows: [] });
  assert.deepEqual(cache.take("a"), { rows: [] });
});

test("environment resets clear output, while deletion removes membership and rejects late saves", () => {
  const cache = new QueryOutputCache<number>();
  cache.retain(["a", "b"]);
  cache.save("a", 1);
  cache.clear();
  assert.equal(cache.take("a"), undefined);
  assert.equal(cache.save("b", 2), true);
  cache.retain(["a"]);
  assert.equal(cache.save("b", 3), false);
  assert.equal(cache.size, 0);
  assert.equal(cache.save("a", 4), true);
  cache.delete("a");
  assert.equal(cache.size, 0);
});

test("a shared output budget evicts least-recent inactive entries across views", async () => {
  const { QueryOutputBudget } = await import("../src/queryOutputs.ts");
  const budget = new QueryOutputBudget(100);
  const create = () =>
    new QueryOutputCache<{ bytes: number; value: string }>({
      budget,
      sizeOf: (output) => output.bytes,
    });
  const a = create(),
    b = create();
  a.retain(["one", "two"]);
  b.retain(["three"]);
  a.save("one", { bytes: 40, value: "oldest" });
  b.save("three", { bytes: 40, value: "other view" });
  a.save("two", { bytes: 40, value: "newest" });
  assert.equal(a.wasEvicted("one"), true);
  assert.equal(a.take("one"), undefined);
  assert.equal(budget.bytes, 80);
  assert.equal(b.take("three")?.value, "other view");
  assert.equal(budget.bytes, 40);
  assert.equal(a.take("two")?.value, "newest");
  assert.equal(budget.bytes, 0);
  a.save("one", { bytes: 40, value: "rerun" });
  assert.equal(a.wasEvicted("one"), false);
  a.clear();
  b.clear();
  assert.equal(budget.bytes, 0);
  assert.equal(budget.size, 0);
});

test("oversized inactive output is rejected without evicting useful entries; taking output protects the active view", async () => {
  const { QueryOutputBudget } = await import("../src/queryOutputs.ts");
  const budget = new QueryOutputBudget(100),
    cache = new QueryOutputCache<{ bytes: number; value: string }>({
      budget,
      sizeOf: (output) => output.bytes,
    });
  cache.retain(["small", "large", "next"]);
  const small = { bytes: 60, value: "small" };
  cache.save("small", small);
  assert.equal(cache.save("large", { bytes: 101, value: "large" }), false);
  assert.equal(cache.wasEvicted("large"), true);
  assert.equal(budget.bytes, 60);
  assert.equal(cache.take("small"), small);
  assert.equal(budget.bytes, 0);
  cache.save("next", { bytes: 90, value: "next" });
  assert.equal(small.value, "small");
  assert.equal(cache.wasEvicted("small"), false);
  cache.retain(["small", "next"]);
  assert.equal(cache.wasEvicted("large"), false);
  cache.delete("next");
  assert.equal(budget.bytes, 0);
});

test("budget resizing, replacement, closure and repeated teardown release every accounted entry", async () => {
  const { QueryOutputBudget } = await import("../src/queryOutputs.ts");
  const budget = new QueryOutputBudget(100),
    cache = new QueryOutputCache<number>({
      budget,
      sizeOf: (output) => output,
    });
  cache.retain(["a", "b"]);
  cache.save("a", 80);
  cache.save("b", 20);
  budget.setLimit(50);
  assert.equal(cache.wasEvicted("a"), true);
  assert.equal(cache.take("b"), 20);
  assert.equal(budget.bytes, 0);
  for (let i = 0; i < 100; i++) {
    cache.save("a", 10);
    cache.save("a", 20);
    assert.equal(budget.bytes, 20);
    cache.retain([]);
    assert.equal(budget.bytes, 0);
    assert.equal(cache.save("a", 1), false);
    cache.retain(["a", "b"]);
  }
  budget.setLimit(0);
  assert.equal(cache.save("a", 1), false);
  assert.equal(budget.size, 0);
  cache.clear();
  assert.equal(cache.wasEvicted("a"), false);
  assert.throws(() => budget.setLimit(-1));
  assert.throws(() => budget.setLimit(NaN));
});

test("output accounting covers large strings, nested/shared data and cycles without JSON encoding", async () => {
  const { estimateQueryOutputBytes } = await import("../src/queryOutputs.ts");
  const small = [{ id: 1, text: "short" }],
    large = [{ id: 1, text: "x".repeat(100000) }];
  assert.ok(
    estimateQueryOutputBytes(large) - estimateQueryOutputBytes(small) >= 199990,
  );
  const shared = { rows: large };
  assert.ok(
    estimateQueryOutputBytes({ a: shared, b: shared }) <
      estimateQueryOutputBytes({
        a: shared,
        b: { rows: [{ id: 1, text: "x".repeat(100000) }] },
      }),
  );
  const cyclic: any = { rows: large };
  cyclic.self = cyclic;
  assert.ok(Number.isFinite(estimateQueryOutputBytes(cyclic)));
});
