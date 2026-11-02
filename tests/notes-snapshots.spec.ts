import { test, expect } from "./fixtures";
const baseline = process.env.ORVANE_NOTES_SNAPSHOT_BASELINE === "1";
test("Notes snapshot allocation and persistence serialization comparison", async ({
  page,
}, info) => {
  test.setTimeout(60000);
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const module = "/tests/notes-snapshots-harness.ts";
    return (await import(module)).profileNotesSnapshots();
  });
  console.log(
    "Notes snapshot diagnostic",
    baseline ? "baseline" : "candidate",
    result,
  );
  await info.attach("notes-snapshots.json", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
  if (!baseline) {
    expect(result.snapshots.documentSerializations).toBe(0);
    expect(result.snapshots.uniqueHistoryBlockObjects).toBe(1099);
    expect(result.snapshots.historyEntries).toBe(100);
    expect(result.persistence.documentSerializations).toBe(0);
    expect(result.persistence.blockPayloadSerializations).toBe(1);
  }
});

test("Notes shared history preserves rich block operations, independent views and durable reopen", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const module = "/tests/notes-snapshots-harness.ts";
    return (await import(module)).exerciseNotesSnapshotHistory();
  });
  expect(result).toEqual({
    movedOrder: [0, 3, 4, 1, 2, 5],
    undoRestored: true,
    redoRestored: true,
    branchClearedRedo: true,
    undoBranch: "Initial",
    redoBranch: "Typing branch",
    sharedUpdate: "Second view",
    independentHistory: true,
    durable: {
      type: "heading1",
      html: "Initial",
      checked: true,
      caption: "After",
      imageWidth: 60,
      lang: "javascript",
    },
    switchedPage: "history-other",
    historyAfterSwitch: 0,
  });
});

test("queued Notes payloads keep their original page and detached data; failed writes remain recoverable", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const module = "/tests/notes-snapshots-harness.ts";
    return (await import(module)).exerciseQueuedNotesSnapshots();
  });
  expect(result).toEqual({
    queuedOrder: [
      "settings:put:snapshot-blocker",
      "blocks:replaceBlocks:queued-page",
      "pages:put:queued-page",
    ],
    captured: "Captured before queue",
    extension: { values: [1] },
    failed: true,
    recovered: "Retry value",
    otherDocument: "",
  });
});
