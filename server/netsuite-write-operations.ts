import { z } from "zod";

// NetSuite tools that change data: a SuiteScript runner and File Cabinet writes.
// They run through the same broker as the reads (explicit target and identity),
// but as "write" commands that are never retried automatically.

export const NETSUITE_WRITE_TOOLS = Object.freeze({
  "run-suitescript": "write.run-suitescript",
  "file-write": "write.file",
  task: "write.task",
} as const);
export type NetSuiteWriteTool = keyof typeof NETSUITE_WRITE_TOOLS;

/** Executor write operations (kept in sync with EXECUTOR_WRITES in electron/netsuite-broker-protocol.mjs; tested). */
export const NETSUITE_EXECUTOR_WRITES = [
  "run-script",
  "upload-file",
  "save-file",
  "create-folder",
  "delete-items",
  "run-task",
  "set-deployment-status",
] as const;

export const FILE_WRITE_MAX_BYTES = 5_000_000;

const identity = {
  targetId: z.string().min(1).max(100),
  identityToken: z.string().min(1).max(100),
};
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\\/\u0000-\u001f]/.test(value), "A file or folder name cannot contain slashes or control characters.");
const folderId = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
  .refine((id) => id !== 0, "Folder ID cannot be zero.");
const positiveId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const netSuiteRunScriptSchema = z
  .object({
    ...identity,
    code: z.string().min(1).max(100_000),
    timeoutSeconds: z.number().int().min(1).max(60).default(30),
    maxResultChars: z.number().int().min(1000).max(200_000).default(50_000),
  })
  .strict();

export const netSuiteFileWriteSchema = z
  .object({
    ...identity,
    action: z.enum(["upload", "update", "delete", "create-folder"]),
    folderId: folderId.optional(),
    name: name.optional(),
    content: z.string().max(FILE_WRITE_MAX_BYTES).optional(),
    base64: z.string().max(7_000_000).regex(/^[a-z0-9+/]*={0,2}$/i, "Invalid base64.").optional(),
    localPath: z.string().min(1).max(1000).optional(),
    overwrite: z.boolean().default(false),
    fileId: positiveId.optional(),
    original: z.string().max(2_000_000).optional(),
    fileIds: z.array(positiveId).max(200).optional(),
    folderIds: z.array(positiveId).max(200).optional(),
  })
  .strict();

export const netSuiteTaskSchema = z
  .object({
    ...identity,
    action: z.enum(["run", "status", "list"]),
    deploymentId: positiveId.optional(),
    runId: z.string().min(1).max(60).optional(),
    waitSeconds: z.number().int().min(0).max(50).default(0),
  })
  .strict();

export const netSuiteWriteSchemas = {
  "run-suitescript": netSuiteRunScriptSchema,
  "file-write": netSuiteFileWriteSchema,
  task: netSuiteTaskSchema,
} as const;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_WRITE" });
}

/** Validates a broker write request; file sources must already be resolved to base64 or content. */
export function parseNetSuiteWrite(request: unknown) {
  if (!request || typeof request !== "object" || Array.isArray(request)) invalid("A write request is required.");
  const { operation, tool, ...input } = request as Record<string, unknown>;
  if (operation !== "write" || typeof tool !== "string" || !Object.hasOwn(NETSUITE_WRITE_TOOLS, tool))
    invalid("Use a known write tool.");
  const parsed = netSuiteWriteSchemas[tool as NetSuiteWriteTool].safeParse(input);
  if (!parsed.success)
    invalid(parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
  const args = parsed.data as Record<string, any>;
  if (tool === "task") {
    if (args.action === "run" && args.deploymentId === undefined) invalid("run needs deploymentId (scriptdeployment.primarykey).");
    if (args.action === "status" && !args.runId) invalid("status needs runId.");
  }
  if (tool === "file-write") {
    if (args.localPath !== undefined) invalid("localPath must be read by the MCP server before the request is sent.");
    if (args.action === "upload") {
      if (args.folderId === undefined || !args.name) invalid("upload needs folderId and name (or localPath).");
      if ((args.content === undefined) === (args.base64 === undefined)) invalid("upload needs exactly one of content, base64 or localPath.");
    }
    if (args.action === "update" && (args.fileId === undefined || args.content === undefined))
      invalid("update needs fileId and content (text files).");
    if (args.action === "delete" && !(args.fileIds?.length || args.folderIds?.length))
      invalid("delete needs fileIds and/or folderIds.");
    if (args.action === "create-folder" && (args.folderId === undefined || !args.name))
      invalid("create-folder needs folderId (the parent) and name.");
  }
  return { tool: tool as NetSuiteWriteTool, args, capability: NETSUITE_WRITE_TOOLS[tool as NetSuiteWriteTool] };
}

/** Caps a script's result and logs so one call cannot flood the conversation. */
export function shapeScriptResult(raw: any, maxResultChars: number) {
  const logs: { level: string; text: string }[] = Array.isArray(raw?.logs) ? raw.logs : [];
  const out: Record<string, unknown> = { ok: raw?.ok === true };
  if (raw?.ok) {
    const text = JSON.stringify(raw.result ?? null);
    if (text.length > maxResultChars) {
      out.result = null;
      out.resultPreview = text.slice(0, maxResultChars);
      out.resultChars = text.length;
      out.note = `The result has ${text.length} characters; showing the first ${maxResultChars}. Return less (filter, slice or summarize in the script) or raise maxResultChars (max 200000).`;
    } else out.result = raw.result ?? null;
  } else {
    out.error = raw?.error ?? { message: "The script failed." };
    const message = String((raw?.error as any)?.message ?? "");
    if (/await is only valid/i.test(message))
      out.hint = "The body already runs inside an async function. This await is inside a nested non-async function (for example a forEach callback): use for...of or make that callback async.";
    else if (/is not defined/i.test(message))
      out.hint = "N modules are available by name (record, search, query, runtime, url, format…) plus sql(query, params). Check the spelling, or that the module exists in client SuiteScript.";
  }
  let budget = 20_000;
  out.logs = logs.filter((entry) => (budget -= entry.text.length) >= 0);
  if ((out.logs as unknown[]).length < logs.length) out.logsTruncated = logs.length - (out.logs as unknown[]).length;
  return out;
}

export const RUN_SUITESCRIPT_DESCRIPTION =
  "Run SuiteScript in the selected NetSuite account, in the signed-in Browser session (client SuiteScript 2.x, the same context as Magic NetSuite's quick script). The code is the body of an async function: use await and return a JSON value. All N modules are available by name (record, search, query, runtime, url, format, currentRecord…), plus sql(query, params) → rows (runSuiteQL as mapped results). console.* and log.* (N/log) output is returned as logs. It can create, update and delete records: it runs exactly what you send, with the user's role, and is never retried automatically. Errors return name (NetSuite error code), message and the line in your code. Result capped at maxResultChars (default 50000). timeoutSeconds default 30, max 60; a timed-out script may still have completed. Server-only modules (N/file contents, N/task, N/render, N/https to external hosts) are not available in client SuiteScript; for files use orvane_netsuite_file_text and orvane_netsuite_file_write.";

export const FILE_WRITE_DESCRIPTION =
  "Change the File Cabinet of the selected NetSuite account. Every write is checked by reading NetSuite back before it is reported. action upload: folderId and name with content (text), base64 or localPath (an absolute path on this computer; name defaults to its file name), up to 5 MB. An existing file with the same name is an error unless overwrite: true, which replaces its content and keeps its file ID (scripts that use it keep working). action update: replace a text file's content by fileId; pass original (the content you read) to refuse the save if someone changed the file meanwhile. action delete: fileIds and/or folderIds (folders must be empty). action create-folder: folderId (the parent; -15 is SuiteScripts) and name. Never retried automatically.";

export const TASK_DESCRIPTION =
  "Run a map/reduce or scheduled script deployment now, the way a person does it in NetSuite: the deployment is put in Not Scheduled, NetSuite's own Save and Execute is pressed, and when the run ends Orvane puts back the deployment's original status (also after an Orvane restart; left alone if someone changed the status meanwhile). If starting fails, the status is put back at once. action run {deploymentId = scriptdeployment.primarykey, waitSeconds 0–50} returns the run (runId, originalStatus, instances with status/percent/stage) · status {runId} reads its progress · list shows this account's recent runs. Script parameters are the deployment's saved ones. It runs real scripts with the user's role: check what the script does first.";
