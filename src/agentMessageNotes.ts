// "Send to Notes" from an agent message: a new Notes page whose blocks follow
// the message's Markdown (headings, bullets, code fences, paragraphs).
import { db, now, uid } from "./components/notes/db";
import type { Block, BlockType, Page } from "./components/notes/types";
// NOTES_WORKSPACE_CHANGED_EVENT in notes/stores/workspace.ts; named here so
// Agent sessions does not load the Notes store.
const NOTES_WORKSPACE_CHANGED_EVENT = "magic-notes-workspace-changed";

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function markdownBlocks(markdown: string) {
  const blocks: { type: BlockType; html: string; lang?: string }[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", html: paragraph.map(escape).join("<br>") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (i + 1 < lines.length && !/^```/.test(lines[i + 1]!)) code.push(lines[++i]!);
      i++;
      blocks.push({ type: "code", html: code.join("\n"), lang: fence[1] || undefined });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: `heading${heading[1]!.length}` as BlockType, html: escape(heading[2]!) });
    } else if (bullet || numbered) {
      flush();
      blocks.push({ type: bullet ? "bulleted" : "numbered", html: escape((bullet ?? numbered)![1]!) });
    } else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Creates a top-level Notes page and returns its ID. */
export async function sendToNotes(title: string, markdown: string) {
  const pages = await db.pages.toArray();
  const stamp = now();
  const page: Page = {
    id: uid(),
    parentId: null,
    type: "page",
    title: title.slice(0, 200),
    icon: null,
    isFavorite: false,
    trashedAt: null,
    position: pages.filter((p) => p.parentId === null).length,
    createdAt: stamp,
    updatedAt: stamp,
  };
  await db.pages.add(page);
  const blocks: Block[] = markdownBlocks(markdown).map((block, position) => ({
    id: uid(),
    pageId: page.id,
    type: block.type,
    html: block.html,
    indent: 0,
    position,
    ...(block.lang ? { lang: block.lang } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  }));
  if (blocks.length) await db.blocks.bulkAdd(blocks);
  window.dispatchEvent(
    new CustomEvent(NOTES_WORKSPACE_CHANGED_EVENT, { detail: { source: "agent-sessions", pages: true } }),
  );
  return page.id;
}
