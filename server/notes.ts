import { join } from "node:path";
import { z } from "zod";
import { LocalDatabase } from "./database.ts";
export const notesSchema = z
  .object({
    collection: z.enum(["pages", "blocks", "settings"]),
    action: z.enum([
      "list",
      "get",
      "put",
      "add",
      "delete",
      "bulkPut",
      "bulkAdd",
      "deletePage",
      "replaceBlocks",
    ]),
    key: z.string().min(1).max(200).optional(),
    pageId: z.string().min(1).max(200).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).max(10000).default([]),
  })
  .strict();
export class NotesService {
  private db?: LocalDatabase;
  constructor(
    private directory: string,
    private filename = "workspace.sqlite",
  ) {}
  invoke(operation: string, args: unknown) {
    if (operation !== "data") throw Error("Unknown notes operation.");
    const p = notesSchema.parse(args);
    if (["get", "delete"].includes(p.action) && !p.key)
      throw Error("A record key is required.");
    if (
      ["deletePage", "replaceBlocks"].includes(p.action) &&
      (!p.pageId || p.collection !== "blocks")
    )
      throw Error("A block page ID is required.");
    this.db ||= new LocalDatabase(join(this.directory, this.filename));
    return this.db.notesData(p.collection, p.action, p.key, p.rows, p.pageId);
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
}
