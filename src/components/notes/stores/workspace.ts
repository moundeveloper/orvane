import DOMPurify from "dompurify";
import { inject, type InjectionKey } from "vue";
import { defineStore, getActivePinia, type Pinia } from "pinia";
import { db, uid, now } from "../db";
import type { Block, BlockType, DbSchema, Page } from "../types";
import {
  captureBlockSnapshot,
  cloneBlockRecord,
  cloneBlockRecords,
  type BlockSnapshot,
} from "../blockSnapshots";

export const NOTES_WORKSPACE_CHANGED_EVENT = "magic-notes-workspace-changed";

export type NotesWorkspaceChange = {
  source: string;
  pages?: boolean;
  blocksPageId?: string;
};

function notifyWorkspaceChanged(detail: NotesWorkspaceChange) {
  window.dispatchEvent(
    new CustomEvent<NotesWorkspaceChange>(NOTES_WORKSPACE_CHANGED_EVENT, {
      detail,
    }),
  );
}

interface State {
  pages: Page[];
  /** blocks of currently open page */
  blocks: Block[];
  /** Identity of the document whose initial block read has completed. */
  blocksPageId: string | null;
  currentPageId: string | null;
  recentIds: string[];
  loaded: boolean;
  undoStack: BlockSnapshot[];
  redoStack: BlockSnapshot[];
}

function sortByPosition<T extends { position: number }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => a.position - b.position);
}

// Migration and welcome seeding are writes. Concurrent view startup must not
// run them once per subscriber after a shared empty metadata response.
let loadingPages: Promise<Page[]> | undefined;

const createWorkspaceDefinition = (id: string) =>
  defineStore(id, {
    state: (): State => ({
      pages: [],
      blocks: [],
      blocksPageId: null,
      currentPageId: null,
      recentIds: [],
      loaded: false,
      undoStack: [],
      redoStack: [],
    }),

    getters: {
      activePages(state): Page[] {
        return state.pages.filter((p) => !p.trashedAt);
      },
      trashedPages(state): Page[] {
        return state.pages.filter((p) => p.trashedAt);
      },
      favorites(): Page[] {
        return this.activePages.filter((p) => p.isFavorite);
      },
      recentPages(state): Page[] {
        return state.recentIds
          .map((id) => state.pages.find((p) => p.id === id && !p.trashedAt))
          .filter((p): p is Page => !!p)
          .slice(0, 6);
      },
      currentPage(state): Page | null {
        return state.pages.find((p) => p.id === state.currentPageId) ?? null;
      },
      childrenByParent(): Map<string | null, Page[]> {
        // Every visible tree item asks whether it has children. Group once
        // per membership/parent/order change instead of scanning all pages
        // for every item. Records remain editable and owned by this store.
        const groups = new Map<string | null, Page[]>();
        for (const page of this.activePages) {
          const parentId = page.parentId;
          let group = groups.get(parentId);
          if (!group) groups.set(parentId, (group = []));
          group.push(page);
        }
        for (const group of groups.values())
          group.sort((a, b) => a.position - b.position);
        return groups;
      },
      childrenOf() {
        // Keep the existing fresh-array contract for callers that rearrange
        // their own list; changing that list must not corrupt the index.
        return (parentId: string | null): Page[] => [
          ...(this.childrenByParent.get(parentId) ?? []),
        ];
      },
      breadcrumb(state): Page[] {
        const chain: Page[] = [];
        let cur = this.currentPage;
        while (cur) {
          chain.unshift(cur);
          cur = state.pages.find((p) => p.id === cur!.parentId) ?? null;
        }
        return chain;
      },
    },

    actions: {
      async load() {
        if (!loadingPages) {
          const loading = (async () => {
            this.pages = await db.pages.toArray();
            await this.removeLegacyBranding();
            if (this.pages.length === 0) await this.seedWelcome();
            return JSON.parse(JSON.stringify(this.pages)) as Page[];
          })();
          loadingPages = loading;
          const cleanup = () => {
            if (loadingPages === loading) loadingPages = undefined;
          };
          void loading.then(cleanup, cleanup);
        }
        this.pages = structuredClone(await loadingPages);
        const recent = await db.settings.get("recentIds");
        this.recentIds = (recent?.value as string[]) ?? [];
        this.loaded = true;
      },

      async refreshPages() {
        const version = nextMetadataRead(this);
        const pages = await db.pages.toArray();
        if (metadataReads.get(this) !== version) return;
        this.pages = pages;
        if (
          this.currentPageId &&
          !this.pages.some((p) => p.id === this.currentPageId && !p.trashedAt)
        ) {
          this.currentPageId = null;
          this.blocks = [];
          this.blocksPageId = null;
          this.undoStack = [];
          this.redoStack = [];
        }
      },

      async refreshBlocks(pageId: string) {
        if (this.currentPageId !== pageId) return;
        const version = nextDocumentRead(this);
        const blocks = await db.blocks.where("pageId").equals(pageId).toArray();
        if (
          this.currentPageId !== pageId ||
          documentReads.get(this) !== version
        )
          return;
        this.blocks = sortByPosition(blocks);
        this.blocksPageId = pageId;
        if (this.ensureTrailingParagraph()) await this.persistBlocks();
      },

      async removeLegacyBranding() {
        const welcome = this.pages.find(
          (page) => page.title === "Welcome to Slate",
        );
        if (!welcome) return;
        welcome.title = "Welcome to Notes";
        await db.pages.put(JSON.parse(JSON.stringify(welcome)));
        const blocks = await db.blocks
          .where("pageId")
          .equals(welcome.id)
          .toArray();
        let changed = false;
        for (const block of blocks) {
          if (block.html === "Welcome to Slate") {
            block.html = "Welcome to Notes";
            changed = true;
          } else if (
            block.html.startsWith("Slate is a <b>local-first</b> workspace.")
          ) {
            block.html = block.html.replace("Slate is a", "Notes is a");
            changed = true;
          }
        }
        if (changed)
          await db.blocks.bulkPut(JSON.parse(JSON.stringify(blocks)));
      },

      async seedWelcome() {
        const page = await this.createPage(null, "Welcome to Notes");
        page.icon = "👋";
        await this.savePage(page);
        const lines: [BlockType, string][] = [
          ["heading1", "Welcome to Notes"],
          [
            "paragraph",
            "Notes is a <b>local-first</b> workspace. Everything stays on this machine — no account, no cloud.",
          ],
          ["heading2", "Basics"],
          ["bulleted", "Type <code>/</code> for the block menu"],
          [
            "bulleted",
            "Use markdown shortcuts: <code>#</code>, <code>-</code>, <code>[]</code>, <code>&gt;</code>, <code>```</code>",
          ],
          ["bulleted", "Press <code>Ctrl+K</code> to search"],
          [
            "bulleted",
            "Drag blocks with the ⠿ handle, indent with <code>Tab</code>",
          ],
          ["todo", "Try checking this off"],
          ["toggle", "This is a toggle — click the arrow"],
          [
            "callout",
            "Create databases with table and board views from the sidebar or <code>/table</code>",
          ],
        ];
        let pos = 0;
        for (const [type, html] of lines) {
          const b: Block = {
            id: uid(),
            pageId: page.id,
            type,
            html,
            indent: 0,
            position: pos++,
            createdAt: now(),
            updatedAt: now(),
          };
          await db.blocks.add(b);
        }
      },

      async createPage(
        parentId: string | null,
        title = "",
        type: "page" | "database" = "page",
      ): Promise<Page> {
        nextMetadataRead(this);
        const siblings = this.pages.filter((p) => p.parentId === parentId);
        const page: Page = {
          id: uid(),
          parentId,
          type,
          title,
          icon: null,
          isFavorite: false,
          trashedAt: null,
          position: siblings.length,
          createdAt: now(),
          updatedAt: now(),
        };
        if (type === "database") {
          page.dbSchema = defaultDbSchema();
        }
        this.pages.push(page);
        await db.pages.add(JSON.parse(JSON.stringify(page)));
        notifyWorkspaceChanged({ source: this.$id, pages: true });
        return page;
      },

      async savePage(page: Page) {
        nextMetadataRead(this);
        page.updatedAt = now();
        const idx = this.pages.findIndex((p) => p.id === page.id);
        if (idx >= 0) this.pages[idx] = page;
        await db.pages.put(JSON.parse(JSON.stringify(page)));
        notifyWorkspaceChanged({ source: this.$id, pages: true });
      },

      async openPage(id: string) {
        const version = nextDocumentRead(this);
        this.currentPageId = id;
        this.undoStack = [];
        this.redoStack = [];
        this.blocks = [];
        this.blocksPageId = null;
        const blocks = await db.blocks.where("pageId").equals(id).toArray();
        if (this.currentPageId !== id || documentReads.get(this) !== version)
          return;
        this.blocks = sortByPosition(blocks);
        this.blocksPageId = id;
        if (this.ensureTrailingParagraph()) await this.persistBlocks();
        this.recentIds = [id, ...this.recentIds.filter((r) => r !== id)].slice(
          0,
          20,
        );
        await db.settings.put({
          key: "recentIds",
          value: JSON.parse(JSON.stringify(this.recentIds)),
        });
      },

      async trashPage(id: string) {
        nextMetadataRead(this);
        const collect = (pid: string): string[] => [
          pid,
          ...this.pages
            .filter((p) => p.parentId === pid && !p.trashedAt)
            .flatMap((p) => collect(p.id)),
        ];
        const ids = collect(id);
        for (const pid of ids) {
          const p = this.pages.find((x) => x.id === pid);
          if (p) {
            p.trashedAt = now();
            await db.pages.put(JSON.parse(JSON.stringify(p)));
          }
        }
        if (this.currentPageId && ids.includes(this.currentPageId))
          this.currentPageId = null;
        notifyWorkspaceChanged({ source: this.$id, pages: true });
      },

      async restorePage(id: string) {
        nextMetadataRead(this);
        const p = this.pages.find((x) => x.id === id);
        if (!p) return;
        p.trashedAt = null;
        // if parent trashed or gone, move to root
        const parent = this.pages.find((x) => x.id === p.parentId);
        if (!parent || parent.trashedAt) p.parentId = null;
        await db.pages.put(JSON.parse(JSON.stringify(p)));
        notifyWorkspaceChanged({ source: this.$id, pages: true });
      },

      async deletePagePermanently(id: string) {
        nextMetadataRead(this);
        const collect = (pid: string): string[] => [
          pid,
          ...this.pages
            .filter((p) => p.parentId === pid)
            .flatMap((p) => collect(p.id)),
        ];
        const ids = collect(id);
        for (const pid of ids) {
          await db.blocks.where("pageId").equals(pid).delete();
          await db.pages.delete(pid);
        }
        this.pages = this.pages.filter((p) => !ids.includes(p.id));
        notifyWorkspaceChanged({ source: this.$id, pages: true });
      },

      async emptyTrash() {
        for (const p of [...this.trashedPages])
          await this.deletePagePermanently(p.id);
      },

      async toggleFavorite(id: string) {
        nextMetadataRead(this);
        const p = this.pages.find((x) => x.id === id);
        if (!p) return;
        p.isFavorite = !p.isFavorite;
        await db.pages.put(JSON.parse(JSON.stringify(p)));
        notifyWorkspaceChanged({ source: this.$id, pages: true });
      },

      async movePage(id: string, newParentId: string | null, position: number) {
        nextMetadataRead(this);
        const p = this.pages.find((x) => x.id === id);
        if (!p) return;
        // prevent cycles
        let cur = newParentId;
        while (cur) {
          if (cur === id) return;
          cur = this.pages.find((x) => x.id === cur)?.parentId ?? null;
        }
        p.parentId = newParentId;
        const siblings = sortByPosition(
          this.activePages.filter(
            (x) => x.parentId === newParentId && x.id !== id,
          ),
        );
        siblings.splice(position, 0, p);
        for (let i = 0; i < siblings.length; i++) {
          const s = siblings[i]!;
          s.position = i;
          await db.pages.put(JSON.parse(JSON.stringify(s)));
        }
        notifyWorkspaceChanged({ source: this.$id, pages: true });
      },

      // ---- blocks ----

      snapshot() {
        this.undoStack.push(
          captureBlockSnapshot(this.blocks, this.undoStack.at(-1)),
        );
        if (this.undoStack.length > 100) this.undoStack.shift();
        this.redoStack = [];
      },

      async undo() {
        if (!this.undoStack.length) return;
        this.redoStack.push(
          captureBlockSnapshot(this.blocks, this.undoStack.at(-1)),
        );
        this.blocks = cloneBlockRecords(this.undoStack.pop()!);
        await this.persistBlocks();
      },

      async redo() {
        if (!this.redoStack.length) return;
        this.undoStack.push(
          captureBlockSnapshot(this.blocks, this.redoStack.at(-1)),
        );
        this.blocks = cloneBlockRecords(this.redoStack.pop()!);
        await this.persistBlocks();
      },

      async persistBlocks() {
        if (!this.currentPageId) return;
        const pageId = this.currentPageId;
        const p = this.currentPage;
        nextDocumentRead(this);
        this.ensureTrailingParagraph();
        await db.replaceBlocks(pageId, cloneBlockRecords(this.blocks));
        if (p) {
          p.updatedAt = now();
          await db.pages.put(JSON.parse(JSON.stringify(p)));
        }
        notifyWorkspaceChanged({
          source: this.$id,
          blocksPageId: pageId,
        });
      },

      newBlock(type: BlockType = "paragraph", html = "", indent = 0): Block {
        return {
          id: uid(),
          pageId: this.currentPageId!,
          type,
          html,
          indent,
          position: 0,
          createdAt: now(),
          updatedAt: now(),
        };
      },

      ensureTrailingParagraph(): boolean {
        const last = this.blocks[this.blocks.length - 1];
        if (!last || !this.currentPageId) return false;
        const isEmptyParagraph =
          last.type === "paragraph" &&
          !last.html.includes("data-page-link") &&
          stripHtml(last.html)
            .replace(/[\u200B\u00A0]/g, "")
            .trim() === "";
        if (isEmptyParagraph) return false;
        this.blocks.push(this.newBlock("paragraph", "", last.indent));
        this.reindex();
        return true;
      },

      async insertBlock(afterIndex: number, block: Block) {
        this.blocks.splice(afterIndex + 1, 0, block);
        this.reindex();
        await this.persistBlocks();
      },

      async removeBlock(index: number) {
        this.blocks.splice(index, 1);
        this.reindex();
        await this.persistBlocks();
      },

      async updateBlock(id: string, patch: Partial<Block>) {
        const b = this.blocks.find((x) => x.id === id);
        if (!b) return;
        nextDocumentRead(this);
        Object.assign(b, patch, { updatedAt: now() });
        if (this.ensureTrailingParagraph()) {
          await this.persistBlocks();
          return;
        }
        await db.blocks.put(cloneBlockRecord(b));
        notifyWorkspaceChanged({ source: this.$id, blocksPageId: b.pageId });
      },

      async moveBlock(from: number, to: number) {
        if (to < 0 || to >= this.blocks.length) return;
        const [b] = this.blocks.splice(from, 1);
        if (!b) return;
        this.blocks.splice(to, 0, b);
        this.reindex();
        await this.persistBlocks();
      },

      async moveBlocks(indices: number[], to: number) {
        const unique = [...new Set(indices)]
          .filter((i) => i >= 0 && i < this.blocks.length)
          .sort((a, b) => a - b);
        if (!unique.length) return;
        const moving = unique.map((i) => this.blocks[i]!);
        const movingSet = new Set(unique);
        const remaining = this.blocks.filter((_, i) => !movingSet.has(i));
        const removedBeforeTarget = unique.filter((i) => i < to).length;
        const insertAt = Math.max(
          0,
          Math.min(remaining.length, to - removedBeforeTarget),
        );
        remaining.splice(insertAt, 0, ...moving);
        this.blocks = remaining;
        this.reindex();
        await this.persistBlocks();
      },

      reindex() {
        this.blocks.forEach((b, i) => (b.position = i));
      },

      // ---- search ----

      async searchAll(
        query: string,
      ): Promise<{ page: Page; excerpt: string }[]> {
        const q = query.toLowerCase().trim();
        if (!q) return [];
        const results: { page: Page; excerpt: string; score: number }[] = [];
        const allBlocks = await db.blocks.toArray();
        const blocksByPage = new Map<string, Block[]>();
        for (const b of allBlocks) {
          if (!blocksByPage.has(b.pageId)) blocksByPage.set(b.pageId, []);
          blocksByPage.get(b.pageId)!.push(b);
        }
        for (const page of this.activePages) {
          const titleHit = page.title.toLowerCase().includes(q);
          let excerpt = "";
          let blockHit = false;
          for (const b of blocksByPage.get(page.id) ?? []) {
            const text = stripHtml(b.html);
            const i = text.toLowerCase().indexOf(q);
            if (i >= 0) {
              blockHit = true;
              excerpt = text.slice(Math.max(0, i - 40), i + q.length + 60);
              break;
            }
          }
          if (titleHit || blockHit) {
            results.push({ page, excerpt, score: titleHit ? 2 : 1 });
          }
        }
        return results.sort((a, b) => b.score - a.score).slice(0, 30);
      },

      // ---- page export ----

      async exportPageMarkdown(pageId: string): Promise<string> {
        const page = this.pages.find((p) => p.id === pageId);
        if (!page) return "";
        const blocks = sortByPosition(
          await db.blocks.where("pageId").equals(pageId).toArray(),
        );
        let md = `# ${page.title || "Untitled"}\n\n`;
        let numCounter = 0;
        for (const b of blocks) {
          const pad = "  ".repeat(b.indent);
          const text = htmlToMd(b.html);
          if (b.type !== "numbered") numCounter = 0;
          switch (b.type) {
            case "heading1":
              md += `# ${text}\n\n`;
              break;
            case "heading2":
              md += `## ${text}\n\n`;
              break;
            case "heading3":
              md += `### ${text}\n\n`;
              break;
            case "bulleted":
              md += `${pad}- ${text}\n`;
              break;
            case "numbered":
              md += `${pad}${++numCounter}. ${text}\n`;
              break;
            case "todo":
              md += `${pad}- [${b.checked ? "x" : " "}] ${text}\n`;
              break;
            case "quote":
              md += `> ${text}\n\n`;
              break;
            case "callout":
              md += `> **Note:** ${text}\n\n`;
              break;
            case "divider":
              md += `---\n\n`;
              break;
            case "code":
              md += `\`\`\`${b.lang ?? ""}\n${stripHtml(b.html)}\n\`\`\`\n\n`;
              break;
            case "toggle":
              md += `${pad}- ${text}\n`;
              break;
            case "image":
              md += `![${b.caption ?? "image"}](${b.html.slice(0, 64)}...)\n\n`;
              break;
            default:
              md += `${pad}${text}\n\n`;
          }
        }
        return md;
      },
    },
  });

export const useWorkspace = createWorkspaceDefinition("workspace");
export type WorkspaceStore = ReturnType<typeof useWorkspace>;

export const notesWorkspaceKey: InjectionKey<WorkspaceStore> =
  Symbol("notes-workspace");

export function createWorkspaceStore(instanceId: string): WorkspaceStore {
  return createWorkspaceDefinition(`workspace:${instanceId}`)();
}

const documentReads = new WeakMap<object, number>();
const metadataReads = new WeakMap<object, number>();
function nextMetadataRead(store: object) {
  const version = (metadataReads.get(store) ?? 0) + 1;
  metadataReads.set(store, version);
  return version;
}
function nextDocumentRead(store: object) {
  const version = (documentReads.get(store) ?? 0) + 1;
  documentReads.set(store, version);
  return version;
}

// This factory owns a unique identity, so teardown cannot delete another
// view's store. Durable note records live in SQLite, outside Pinia.
export function createOwnedWorkspaceStore(
  instanceId: string,
  pinia: Pinia | undefined = getActivePinia(),
) {
  if (!pinia) throw Error("Notes requires an active Pinia instance.");
  const store = createWorkspaceDefinition(`workspace:${instanceId}:${uid()}`)(
    pinia,
  );
  return {
    store,
    dispose() {
      nextDocumentRead(store);
      nextMetadataRead(store);
      store.$dispose();
      delete pinia.state.value[store.$id];
    },
  };
}

export function useNotesWorkspace(): WorkspaceStore {
  return inject(notesWorkspaceKey, null) ?? useWorkspace();
}

export function defaultDbSchema(): DbSchema {
  const statusOpts = [
    { id: uid(), name: "Not started", color: "#9ca3af" },
    { id: uid(), name: "In progress", color: "#3b82f6" },
    { id: uid(), name: "Done", color: "#22c55e" },
  ];
  const statusId = uid();
  return {
    properties: [
      { id: statusId, name: "Status", type: "select", options: statusOpts },
      { id: uid(), name: "Date", type: "date" },
      { id: uid(), name: "Notes", type: "text" },
    ],
    views: [
      {
        id: uid(),
        name: "Table",
        type: "table",
        filters: [],
        filterMode: "and",
        sorts: [],
      },
      {
        id: uid(),
        name: "Board",
        type: "board",
        groupBy: statusId,
        filters: [],
        filterMode: "and",
        sorts: [],
      },
    ],
  };
}

export function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = DOMPurify.sanitize(html);
  return div.textContent ?? "";
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlToMd(html: string): string {
  return html
    .replace(
      /<b>(.*?)<\/b>|<strong>(.*?)<\/strong>/g,
      (_, a, b) => `**${a ?? b}**`,
    )
    .replace(/<i>(.*?)<\/i>|<em>(.*?)<\/em>/g, (_, a, b) => `*${a ?? b}*`)
    .replace(/<code>(.*?)<\/code>/g, "`$1`")
    .replace(
      /<s>(.*?)<\/s>|<strike>(.*?)<\/strike>/g,
      (_, a, b) => `~~${a ?? b}~~`,
    )
    .replace(/<a href="(.*?)".*?>(.*?)<\/a>/g, "[$2]($1)")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}
