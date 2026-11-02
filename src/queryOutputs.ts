// Recomputable output belongs only to open query tabs. Taking a tab's output
// transfers ownership back to the view so reruns/clears cannot leave a second
// reference to an obsolete result in the cache. SQL and editor history have
// separate owners and are never stored or evicted here.
export class QueryOutputCache<T> {
  private open = new Set<string>();
  private entries = new Map<string, T>();

  retain(ids: Iterable<string>) {
    this.open = new Set(ids);
    for (const id of this.entries.keys()) {
      if (!this.open.has(id)) this.entries.delete(id);
    }
  }

  save(id: string, output: T) {
    // Also rejects a late save from a closed/deleted tab's transition.
    if (!this.open.has(id)) return false;
    this.entries.set(id, output);
    return true;
  }

  take(id: string) {
    const output = this.entries.get(id);
    this.entries.delete(id);
    return output;
  }

  delete(id: string) {
    this.entries.delete(id);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
