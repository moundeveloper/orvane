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
