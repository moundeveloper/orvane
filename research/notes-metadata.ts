import { createPinia, disposePinia } from "pinia";
import { createOwnedWorkspaceStore } from "../src/components/notes/stores/workspace.ts";
import type { Page } from "../src/components/notes/types.ts";

// Count actual store getter work, without treating Node timings as UI latency.
const views = 12,
  count = 500;
let parentReads = 0;
const pinia = createPinia();
const stores = Array.from({ length: views }, (_, view) => {
  const owned = createOwnedWorkspaceStore(`metadata-${view}`, pinia);
  owned.store.pages = Array.from(
    { length: count },
    (_, i) =>
      ({
        id: `page-${i}`,
        type: "page",
        title: `Page ${i}`,
        get parentId() {
          parentReads++;
          return null;
        },
        icon: null,
        isFavorite: false,
        trashedAt: null,
        position: i,
        createdAt: "2026-11-02",
        updatedAt: "2026-11-02",
      }) satisfies Page,
  );
  return owned;
});
try {
  parentReads = 0;
  let lookups = 0,
    children = 0;
  for (const { store } of stores) {
    // Sidebar root rendering plus PageTreeItem's child-presence lookup for
    // every displayed root. Repeat to exercise stable computed caching.
    for (let pass = 0; pass < 2; pass++) {
      children += store.childrenOf(null).length;
      lookups++;
      for (let i = 0; i < count; i++) {
        children += store.childrenOf(`page-${i}`).length;
        lookups++;
      }
    }
  }
  const initialParentReads = parentReads;
  for (const { store } of stores) store.pages[0]!.title = "Renamed";
  parentReads = 0;
  for (const { store } of stores) {
    store.childrenOf(null);
    for (let i = 0; i < count; i++) store.childrenOf(`page-${i}`);
  }
  console.log(
    JSON.stringify(
      {
        views,
        pagesPerView: count,
        lookups,
        children,
        initialParentReads,
        parentReadsAfterRename: parentReads,
      },
      null,
      2,
    ),
  );
} finally {
  stores.forEach((store) => store.dispose());
  disposePinia(pinia);
}
