import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalDatabase } from "./database.ts";
import {
  applyCommands,
  readOperations,
  type Command,
} from "../src/automation.ts";
export class OfflineWorkspace {
  private db?: LocalDatabase;
  constructor(private directory: string) {}
  private get database() {
    return (this.db ||= new LocalDatabase(
      join(this.directory, "workspace.sqlite"),
    ));
  }
  status() {
    const saved = this.database.read();
    return {
      available: !!saved.data,
      editable: !this.database.editingActive(),
      revision: `sqlite:${saved.revision}`,
    };
  }
  request(
    command: { commands?: Command[]; recovery?: "preview" | "restore" },
    expected?: string,
  ) {
    const db = this.database;
    const mutates =
      command.recovery === "restore" ||
      command.commands?.some((c) => !readOperations.has(c.operation));
    if (command.commands?.some((c) => c.operation === "app_focus"))
      throw Error(
        "No live browser is connected to navigate. Open the saved app from its dock tab when Orvane is open.",
      );
    const owner = randomUUID();
    if (mutates && !db.acquire(owner).owned)
      throw Error(
        "A browser currently owns editing. Connect that browser to MCP or close it before making offline edits.",
      );
    try {
      const saved = db.read(),
        revision = `sqlite:${saved.revision}`;
      if (expected !== undefined && expected !== revision)
        throw Error(
          "The saved workspace changed. Read it again before applying this edit.",
        );
      if (!saved.data)
        throw Error(
          "Open Orvane once to initialize or migrate its workspace before using offline MCP tools.",
        );
      if (command.recovery === "preview")
        return { revision, snapshot: db.snapshot() || null };
      if (command.recovery === "restore") {
        const snapshot = db.snapshot();
        if (!snapshot) throw Error("No local recovery snapshot is available.");
        const written = db.write(
          owner,
          saved.revision,
          snapshot.data,
          "Before offline MCP recovery",
        );
        return {
          revision: `sqlite:${written.revision}`,
          results: [{ restored: true }],
          changed: true,
        };
      }
      if (!command.commands) throw Error("No MCP operations were supplied.");
      const output = applyCommands(saved.data, command.commands);
      if (!output.changed)
        return { revision, results: output.results, changed: false };
      const written = db.write(
        owner,
        saved.revision,
        output.workspace,
        "Before offline MCP edit",
      );
      return {
        revision: `sqlite:${written.revision}`,
        results: output.results,
        changed: true,
      };
    } finally {
      if (mutates) db.release(owner);
    }
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
}
