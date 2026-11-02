// This is a conservative data-size estimate for cache accounting, not a JS
// heap measurement. Count UTF-16 string storage, values and container slots
// without creating a serialized copy of a potentially large result.
export function estimateQueryOutputBytes(value: unknown): number {
  const pending = [value],
    seen = new Set<object>();
  let bytes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      bytes += item.length * 2;
      continue;
    }
    if (typeof item === "number") {
      bytes += 8;
      continue;
    }
    if (typeof item === "boolean") {
      bytes += 4;
      continue;
    }
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) {
      bytes += 24 + item.length * 8;
      for (const child of item) pending.push(child);
    } else {
      bytes += 32;
      for (const key of Object.keys(item)) {
        bytes += 16 + key.length * 2;
        pending.push((item as Record<string, unknown>)[key]);
      }
    }
  }
  return bytes;
}

// All query views share this budget for inactive outputs. Active output is
// owned by its view and is removed from the budget when taken from the cache.
export class QueryOutputBudget {
  private entries = new Map<object, { bytes: number; evict: () => void }>();
  private used = 0;
  constructor(private maximum: number) {
    this.validate(maximum);
  }
  private validate(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw Error("Invalid query output budget.");
  }
  get limit() {
    return this.maximum;
  }
  get bytes() {
    return this.used;
  }
  get size() {
    return this.entries.size;
  }
  setLimit(bytes: number) {
    this.validate(bytes);
    this.maximum = bytes;
    this.trim();
  }
  add(token: object, bytes: number, evict: () => void) {
    this.remove(token);
    const weight =
      Number.isFinite(bytes) && bytes >= 0
        ? Math.ceil(bytes)
        : this.maximum + 1;
    // An oversized output cannot fit even after eviction; preserve other tabs.
    if (weight > this.maximum) {
      evict();
      return;
    }
    this.entries.set(token, { bytes: weight, evict });
    this.used += weight;
    this.trim();
  }
  remove(token: object) {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.used -= entry.bytes;
    this.entries.delete(token);
  }
  private trim() {
    while (this.used > this.maximum && this.entries.size) {
      const [token, entry] = this.entries.entries().next().value!;
      this.remove(token);
      entry.evict();
    }
  }
}
export const QUERY_OUTPUT_BUDGET_BYTES = 64 * 1024 * 1024;
export const queryOutputBudget = new QueryOutputBudget(
  QUERY_OUTPUT_BUDGET_BYTES,
);

// Recomputable output belongs only to open query tabs. SQL and editor history
// have separate owners and never enter this cache or its eviction budget.
export class QueryOutputCache<T> {
  private open = new Set<string>();
  private entries = new Map<string, { output: T; token: object }>();
  private evicted = new Set<string>();
  constructor(
    private options?: {
      budget: QueryOutputBudget;
      sizeOf: (output: T) => number;
    },
  ) {}
  retain(ids: Iterable<string>) {
    this.open = new Set(ids);
    for (const id of this.entries.keys())
      if (!this.open.has(id)) this.delete(id);
    for (const id of this.evicted)
      if (!this.open.has(id)) this.evicted.delete(id);
  }
  save(id: string, output: T) {
    if (!this.open.has(id)) return false;
    this.delete(id);
    const entry = { output, token: {} };
    this.entries.set(id, entry);
    this.options?.budget.add(entry.token, this.options.sizeOf(output), () => {
      if (this.entries.get(id) !== entry) return;
      this.entries.delete(id);
      this.evicted.add(id);
    });
    return this.entries.has(id);
  }
  take(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.options?.budget.remove(entry.token);
    return entry.output;
  }
  wasEvicted(id: string) {
    return this.evicted.has(id);
  }
  delete(id: string) {
    const entry = this.entries.get(id);
    if (entry) this.options?.budget.remove(entry.token);
    this.entries.delete(id);
    this.evicted.delete(id);
  }
  clear() {
    for (const id of this.entries.keys()) this.delete(id);
    this.evicted.clear();
  }
  get size() {
    return this.entries.size;
  }
}
