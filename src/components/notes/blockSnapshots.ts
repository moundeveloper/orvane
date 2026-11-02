import type { Block } from "./types";

export type BlockSnapshot = readonly Readonly<Block>[];
type RecordData = Record<string, unknown>;
const data = (block: Readonly<Block>) => block as unknown as RecordData;
const scalar = (value: unknown) =>
  typeof value === "number" && value === 0 ? 0 : value;

// Current Block fields are scalar. Unknown/nested imported fields retain the
// previous JSON-copy semantics instead of sharing mutable extension objects.
function flatKeys(block: Readonly<Block>): string[] | undefined {
  const prototype = Object.getPrototypeOf(block);
  if (prototype !== Object.prototype && prototype !== null) return;
  const source = data(block);
  const keys = Object.keys(source).filter((key) => source[key] !== undefined);
  for (const key of keys) {
    const value = source[key];
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    )
      return;
  }
  return keys;
}
function copy(block: Readonly<Block>, keys: string[] | undefined): Block {
  if (!keys) return JSON.parse(JSON.stringify(block)) as Block;
  const source = data(block);
  return Object.fromEntries(
    keys.map((key) => [key, scalar(source[key])]),
  ) as unknown as Block;
}
function freezeJson(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}
export function cloneBlockRecord(block: Readonly<Block>): Block {
  return copy(block, flatKeys(block));
}
export function cloneBlockRecords(blocks: readonly Readonly<Block>[]): Block[] {
  return blocks.map(cloneBlockRecord);
}
export function captureBlockSnapshot(
  blocks: readonly Readonly<Block>[],
  previous: BlockSnapshot = [],
): BlockSnapshot {
  const candidates = new Map(previous.map((block) => [block.id, block]));
  return Object.freeze(
    blocks.map((block) => {
      const keys = flatKeys(block),
        candidate = candidates.get(block.id);
      if (
        keys &&
        candidate &&
        Object.isFrozen(candidate) &&
        Object.keys(candidate).length === keys.length &&
        keys.every(
          (key) =>
            Object.hasOwn(candidate, key) &&
            data(candidate)[key] === scalar(data(block)[key]),
        )
      )
        return candidate;
      const captured = copy(block, keys);
      freezeJson(captured);
      return captured;
    }),
  );
}
