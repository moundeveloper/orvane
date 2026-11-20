import { z } from "zod";
import { extractPdfText } from "./netsuite-pdf-text.ts";

// Read-only NetSuite helpers ported from Magic NetSuite. Each tool compiles to
// fixed SELECTs or one of a few allowlisted page reads; callers never send SQL
// or page code. Results are bounded and shaped here so the broker stays small.

export const NETSUITE_METADATA_TOOLS = Object.freeze({
  bundles: "metadata.bundles",
  "file-text": "metadata.file-text",
  schema: "metadata.schema",
  "field-info": "metadata.field-info",
  "find-records": "metadata.find-records",
  logs: "metadata.logs",
} as const);
export type NetSuiteMetadataTool = keyof typeof NETSUITE_METADATA_TOOLS;

/** Page reads the executor may run for metadata tools, with sanitized args. */
export const NETSUITE_PAGE_READS = [
  "bundles",
  "bundle-contents",
  "file-content",
  "catalog-tables",
  "catalog-table",
  "log-search",
] as const;

export const FILE_TEXT_MAX_BYTES = 600_000;
const LOG_LEVELS = ["DEBUG", "AUDIT", "ERROR", "EMERGENCY", "SYSTEM"] as const;

const identity = {
  targetId: z.string().min(1).max(100),
  identityToken: z.string().min(1).max(100),
};
const searchText = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (value) => !/[\u0000-\u001f\u007f;]/.test(value),
    "Text cannot contain control characters or semicolons.",
  );
const positiveId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const tableName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z][a-z0-9_]*$/i, "Use a record catalog table ID.");

export const netSuiteBundlesSchema = z
  .object({
    ...identity,
    action: z.enum(["list", "components"]).default("list"),
    bundleType: z.enum(["installed", "created", "both"]).default("both"),
    bundleId: positiveId.optional(),
    name: searchText.optional(),
  })
  .strict();
export const netSuiteFileTextSchema = z
  .object({
    ...identity,
    fileId: positiveId,
    offset: z.number().int().min(0).max(10_000_000).default(0),
    maxChars: z.number().int().min(1).max(200_000).default(50_000),
  })
  .strict();
export const netSuiteSchemaSchema = z
  .object({
    ...identity,
    action: z.enum(["tables", "fields", "joins"]),
    query: searchText.optional(),
    table: tableName.optional(),
  })
  .strict();
export const netSuiteFieldInfoSchema = z
  .object({
    ...identity,
    scriptId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/i, "Use a custom field script ID."),
    optionLimit: z.number().int().min(0).max(100).default(50),
  })
  .strict();
export const netSuiteFindRecordsSchema = z
  .object({
    ...identity,
    recordType: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/i, "Use a SuiteQL record type."),
    query: searchText.optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
const isoDate = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Use an ISO date.");
export const netSuiteLogsSchema = z
  .object({
    ...identity,
    from: isoDate.optional(),
    to: isoDate.optional(),
    levels: z.array(z.enum(LOG_LEVELS)).max(5).optional(),
    scriptIds: z.array(positiveId).max(50).optional(),
    deploymentIds: z.array(positiveId).max(50).optional(),
    scriptTypes: z.array(searchText).max(20).optional(),
    title: searchText.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const netSuiteMetadataSchemas = {
  bundles: netSuiteBundlesSchema,
  "file-text": netSuiteFileTextSchema,
  schema: netSuiteSchemaSchema,
  "field-info": netSuiteFieldInfoSchema,
  "find-records": netSuiteFindRecordsSchema,
  logs: netSuiteLogsSchema,
} as const;

export const SUITEQL_TIPS =
  "SuiteQL is Oracle-style: there is no LIMIT (filter with ROWNUM <= n, or page with offset), dates use TO_DATE('2026-01-31','YYYY-MM-DD'), string comparison is case-sensitive (use LOWER(x) LIKE '%term%'), BUILTIN.DF(field) returns a list/record field's display text, and transaction.type uses codes such as CustInvc, SalesOrd, VendBill. Do not guess names: find tables with orvane_netsuite_schema action tables, read columns with action fields and join keys with action joins, then sample distinct values with SELECT DISTINCT col FROM t WHERE col IS NOT NULL. scriptdeployment.primarykey is the deployment record ID (scriptdeployment.id is not). A number given as a customer/transaction ID is a record ID, never a File Cabinet ID.";

/** Magic's guard: LIMIT is not SuiteQL. Ignores LIMIT inside strings and comments. */
export function suiteQlLimitHint(sql: string) {
  const code = sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  if (!/\bLIMIT\s+\d+/i.test(code) && !/\bLIMIT\b\s*$/i.test(code.trim()))
    return null;
  return "LIMIT is not valid SuiteQL syntax. Filter with ROWNUM in the WHERE clause instead, for example: SELECT id, companyname FROM customer WHERE ROWNUM <= 10. Results are already paged at 100 rows; use offset for more.";
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_METADATA_READ" });
}
export function parseNetSuiteMetadata(request: unknown) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    invalid("A metadata request is required.");
  const { operation, tool, ...input } = request as Record<string, unknown>;
  if (operation !== "metadata" || typeof tool !== "string" || !Object.hasOwn(NETSUITE_METADATA_TOOLS, tool))
    invalid("Use a known metadata tool.");
  const parsed = netSuiteMetadataSchemas[tool as NetSuiteMetadataTool].safeParse(input);
  if (!parsed.success)
    invalid(parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "));
  const args = parsed.data as Record<string, any>;
  if (tool === "bundles" && args.action === "components" && args.bundleId === undefined)
    invalid("components requires bundleId.");
  if (tool === "schema" && args.action !== "tables" && !args.table)
    invalid("fields and joins require table.");
  if (tool === "logs" && args.from && args.to && Date.parse(args.from) > Date.parse(args.to))
    invalid("from must be before to.");
  return { tool: tool as NetSuiteMetadataTool, args, capability: NETSUITE_METADATA_TOOLS[tool as NetSuiteMetadataTool] };
}

export type MetadataRunner = {
  /** One fixed SELECT page (100 rows), already identity-checked by the broker. */
  query: (sql: string, offset?: number) => Promise<{ rows: Record<string, unknown>[]; totalCount?: number }>;
  page: (operation: (typeof NETSUITE_PAGE_READS)[number], args: Record<string, unknown>) => Promise<any>;
};

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const contains = (column: string, value: string) => `INSTR(LOWER(${column}), LOWER(${literal(value)})) > 0`;

/** RFC 4180 CSV, including quoted commas, quotes and newlines. */
export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") row.push(field), (field = "");
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row.map((value) => value.trim()));
      (row = []), (field = "");
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row.map((value) => value.trim()));
  return rows;
}

const BUNDLE_FIELDS: Record<string, string> = {
  Name: "name",
  "Bundle ID": "bundleId",
  Version: "version",
  "App ID": "appId",
  Abstract: "abstract",
  "Created By": "createdBy",
  "Created On": "createdOn",
  "Last Update": "lastUpdate",
};
export function parseBundleList(csv: string, type: "installed" | "created") {
  const rows = parseCsv(csv);
  // NetSuite puts a title line above the header row.
  const header = rows.findIndex((row) => row.includes("Bundle ID"));
  if (header < 0) return [];
  const headers = rows[header]!;
  return rows
    .slice(header + 1)
    .map((values) => {
      const bundle: Record<string, string> = { type };
      headers.forEach((name, index) => {
        if (BUNDLE_FIELDS[name]) bundle[BUNDLE_FIELDS[name]] = values[index] ?? "";
      });
      return bundle;
    })
    .filter((bundle) => bundle.bundleId);
}
export function parseBundleContents(csv: string) {
  const rows = parseCsv(csv).slice(1);
  const marker = (row?: string[]) => Boolean(row?.[0]) && !row?.[1] && !row?.[2] && !row?.[3];
  let category = "",
    subCategory = "";
  const components = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (marker(row)) {
      // A marker followed by data names a subcategory; one followed by another marker, a category.
      if (rows[i + 1] && !marker(rows[i + 1])) subCategory = row[0]!;
      else (category = row[0]!), (subCategory = "");
      continue;
    }
    const [name, id = "", referencedBy = "", locked = ""] = row;
    if (!name) continue;
    components.push({ name, id, referencedBy, isLocked: Boolean(locked), category, subCategory });
  }
  return components;
}

const TRANSACTION_TYPES: Record<string, string> = {
  salesorder: "SalesOrd",
  invoice: "CustInvc",
  purchaseorder: "PurchOrd",
  vendorbill: "VendBill",
  estimate: "Estimate",
  creditmemo: "CustCred",
  vendorcredit: "VendCred",
  journalentry: "Journal",
  itemfulfillment: "ItemShip",
  itemreceipt: "ItemRcpt",
  cashsale: "CashSale",
  customerpayment: "CustPymt",
  vendorpayment: "VendPymt",
  returnauthorization: "RtnAuth",
  transferorder: "TrnfrOrd",
  inventoryadjustment: "InvAdjst",
  check: "Check",
  deposit: "Deposit",
  expensereport: "ExpRept",
};
const LABEL_COLUMNS = ["name", "entityid", "altname", "scriptid", "itemid", "title"];
/** Candidate SELECTs, most specific first. ORDER BY without ROWNUM so paging returns the newest rows. */
export function recordSearchQueries(recordType: string, query?: string) {
  const type = recordType.toLowerCase();
  const numeric = query && /^\d{1,15}$/.test(query) ? Number(query) : undefined;
  const match = (columns: string[]) => {
    if (!query) return "";
    const parts = columns.map((column) => contains(column, query));
    if (numeric !== undefined) parts.unshift(`id = ${numeric}`);
    return ` WHERE (${parts.join(" OR ")})`;
  };
  const code = TRANSACTION_TYPES[type];
  if (code || type === "transaction") {
    const where = [code ? `type = ${literal(code)}` : "", match(["tranid", "BUILTIN.DF(entity)"]).replace(/^ WHERE /, "")].filter(Boolean);
    return [
      `SELECT id, tranid, BUILTIN.DF(type) AS type, BUILTIN.DF(entity) AS entity, trandate, BUILTIN.DF(status) AS status FROM transaction${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`,
    ];
  }
  // One label column per try: a SELECT naming a column the table lacks fails as a whole.
  return [
    ...LABEL_COLUMNS.map((column) => `SELECT id, ${column} FROM ${type}${match([column])} ORDER BY id DESC`),
    ...(query ? [] : [`SELECT id FROM ${type} ORDER BY id DESC`]),
  ];
}
export function summarizeRecord(row: Record<string, unknown>) {
  const entries = Object.entries(row).filter(([key, value]) => key.toLowerCase() !== "id" && value !== null && value !== undefined && value !== "");
  const label = String(
    row.tranid ?? row.name ?? row.entityid ?? row.altname ?? row.itemid ?? row.scriptid ?? row.title ?? row.id ?? "",
  );
  return {
    id: String(row.id ?? ""),
    label,
    meta: entries.slice(0, 4).map(([key, value]) => `${key}: ${String(value)}`).join(" | "),
  };
}

const LEVEL_SET = new Set<string>(LOG_LEVELS);
export function filterLogs(
  rows: Record<string, any>[],
  args: { from?: string; to?: string; scriptTypes?: string[]; title?: string; limit: number },
  serverTotal: number,
) {
  const from = args.from ? Date.parse(args.from) : undefined;
  const to = args.to ? Date.parse(args.to) : undefined;
  const types = args.scriptTypes?.map((type) => type.toLowerCase());
  const matched = rows.filter((row) => {
    const at = row.datetime ? Date.parse(row.datetime) : NaN;
    if (from !== undefined && !(at >= from)) return false;
    if (to !== undefined && !(at <= to)) return false;
    if (types && !types.some((type) => String(row.scriptType ?? "").toLowerCase().includes(type))) return false;
    if (args.title && !String(row.title ?? "").toLowerCase().includes(args.title.toLowerCase())) return false;
    return true;
  });
  const logs = matched.slice(0, args.limit);
  const scannedAll = rows.length >= serverTotal;
  return {
    logs,
    returned: logs.length,
    matched: matched.length,
    scanned: rows.length,
    serverMatches: serverTotal,
    complete: scannedAll && logs.length === matched.length,
    note:
      logs.length < matched.length || !scannedAll
        ? `Showing ${logs.length} of ${scannedAll ? matched.length : `at least ${matched.length}`} logs (newest first; scanned ${rows.length} of ${serverTotal} in the date range). Narrow the range or add level/script filters for more specific results.`
        : undefined,
  };
}

function sliceText(content: string, offset: number, maxChars: number) {
  const text = content.slice(offset, offset + maxChars);
  const next = offset + text.length;
  return { content: text, offset, totalChars: content.length, nextOffset: next < content.length ? next : null };
}

/** Runs one parsed metadata tool. Every NetSuite access goes through runner. */
export async function runNetSuiteMetadata(
  parsed: ReturnType<typeof parseNetSuiteMetadata>,
  runner: MetadataRunner,
): Promise<Record<string, unknown>> {
  const { tool, args } = parsed;
  if (tool === "bundles") {
    if (args.action === "components") {
      const { csv } = await runner.page("bundle-contents", { bundleId: args.bundleId });
      let components = parseBundleContents(String(csv ?? ""));
      if (args.name) components = components.filter((c) => c.name.toLowerCase().includes(args.name.toLowerCase()));
      const categories: Record<string, number> = {};
      for (const c of components) categories[c.category || "(none)"] = (categories[c.category || "(none)"] ?? 0) + 1;
      return { bundleId: args.bundleId, count: components.length, categories, components };
    }
    const types = args.bundleType === "both" ? (["installed", "created"] as const) : [args.bundleType as "installed" | "created"];
    const bundles = [];
    for (const type of types) {
      const { csv } = await runner.page("bundles", { bundleType: type === "installed" ? "I" : "S" });
      bundles.push(...parseBundleList(String(csv ?? ""), type));
    }
    const filtered = args.name ? bundles.filter((b) => `${b.name} ${b.bundleId}`.toLowerCase().includes(args.name.toLowerCase())) : bundles;
    return { count: filtered.length, bundles: filtered };
  }
  if (tool === "file-text") {
    const file = await runner.page("file-content", { id: args.fileId });
    const meta = {
      fileId: Number(file.id ?? args.fileId),
      name: file.name,
      filetype: file.filetype,
      filesize: Number(file.filesize ?? 0),
      folder: file.folder,
      contentType: file.contentType,
    };
    if (file.kind === "text") return { ...meta, kind: "text", ...sliceText(String(file.content ?? ""), args.offset, args.maxChars) };
    if (file.kind === "pdf") {
      const pdf = extractPdfText(Buffer.from(String(file.base64 ?? ""), "base64"));
      if (!pdf.text)
        return { ...meta, kind: "pdf", pageCount: pdf.pageCount, extractedText: false, content: "", message: "This PDF has no extractable text layer (scanned image or unsupported font encoding)." };
      return { ...meta, kind: "pdf", pageCount: pdf.pageCount, extractedText: true, ...sliceText(pdf.text, args.offset, args.maxChars) };
    }
    return { ...meta, kind: "binary", content: "", message: "Binary file: content is not returned. Use the File Explorer to open or download it." };
  }
  if (tool === "schema") {
    if (args.action === "tables") {
      const { tables } = await runner.page("catalog-tables", {});
      const list: { id: string; label: string }[] = (tables ?? []).filter((t: any) => typeof t?.id === "string");
      const query = args.query?.toLowerCase();
      const matched = query ? list.filter((t) => t.id.toLowerCase().includes(query) || String(t.label ?? "").toLowerCase().includes(query)) : list;
      return {
        total: list.length,
        matched: matched.length,
        tables: matched.slice(0, 50).map((t) => ({ id: t.id, label: t.label ?? "" })),
        note: matched.length > 50 ? `Showing 50 of ${matched.length}. Add or refine query.` : undefined,
      };
    }
    const detail = await runner.page("catalog-table", { table: args.table });
    const query = args.query?.toLowerCase();
    const keep = (item: { id?: string; label?: string }) =>
      !query || String(item.id ?? "").toLowerCase().includes(query) || String(item.label ?? "").toLowerCase().includes(query);
    if (args.action === "fields") {
      const fields = (detail.fields ?? [])
        .filter((f: any) => f?.isColumn !== false && typeof f?.id === "string")
        .map((f: any) => ({ id: f.id, label: f.label ?? "", dataType: f.dataType ?? null }))
        .filter(keep);
      return { table: args.table, fieldCount: fields.length, fields };
    }
    const joins = (detail.joins ?? []).filter(keep);
    return { table: args.table, joinCount: joins.length, joins };
  }
  if (tool === "field-info") {
    const id = args.scriptId.toUpperCase();
    const columns = "internalid, scriptid, name, description, fieldtype, fieldvaluetype, fieldvaluetyperecord, recordtype, ismandatory, isshowinlist, isstored, BUILTIN.DF(owner) AS owner, lastmodifieddate";
    let rows;
    try {
      ({ rows } = await runner.query(`SELECT ${columns}, BUILTIN.DF(fieldvaluetyperecord) AS sourcename, BUILTIN.DF(recordtype) AS recordtypename FROM customfield WHERE UPPER(scriptid) = ${literal(id)}`));
    } catch {
      ({ rows } = await runner.query(`SELECT ${columns} FROM customfield WHERE UPPER(scriptid) = ${literal(id)}`));
    }
    const field = rows[0];
    if (!field) {
      // Body/column/entity fields of other families may still be queryable; say so instead of guessing.
      return { found: false, scriptId: id, message: "No custom field with this script ID. Check the ID, or search: SELECT scriptid, name FROM customfield WHERE LOWER(scriptid) LIKE '%term%'." };
    }
    const result: Record<string, unknown> = {
      found: true,
      id: Number(field.internalid),
      scriptId: field.scriptid,
      label: field.name,
      description: field.description ?? null,
      family: field.fieldtype,
      valueType: field.fieldvaluetype,
      mandatory: field.ismandatory === "T",
      showInList: field.isshowinlist === "T",
      stored: field.isstored === "T",
      appliesToCustomRecord: field.recordtype ?? null,
      appliesToCustomRecordName: field.recordtypename ?? undefined,
      owner: field.owner ?? null,
      lastModified: field.lastmodifieddate ?? null,
    };
    const source = Number(field.fieldvaluetyperecord);
    if (Number.isSafeInteger(source) && source !== 0) {
      result.source = { id: source, name: field.sourcename ?? null };
      if (source > 0) {
        const lists = await runner.query(`SELECT internalid, scriptid, name FROM customlist WHERE internalid = ${source}`).catch(() => ({ rows: [] }));
        const list = lists.rows[0];
        if (list && typeof list.scriptid === "string" && /^[a-z][a-z0-9_]*$/i.test(list.scriptid)) {
          result.source = { kind: "customlist", id: source, scriptId: list.scriptid, name: list.name };
          if (args.optionLimit > 0) {
            const options = await runner.query(`SELECT id, name, isinactive FROM ${list.scriptid.toLowerCase()} ORDER BY id`).catch(() => null);
            if (options) {
              result.options = options.rows.slice(0, args.optionLimit).map((o) => ({ value: Number(o.id), text: o.name, inactive: o.isinactive === "T" }));
              result.optionCount = options.totalCount ?? options.rows.length;
            }
          }
        } else {
          const records = await runner.query(`SELECT internalid, scriptid, name FROM customrecordtype WHERE internalid = ${source}`).catch(() => ({ rows: [] }));
          if (records.rows[0]) result.source = { kind: "customrecord", id: source, scriptId: records.rows[0].scriptid, name: records.rows[0].name };
        }
      } else result.source = { kind: "standard", id: source, name: field.sourcename ?? null };
    }
    return result;
  }
  if (tool === "find-records") {
    // Try name → entityid → altname → scriptid → itemid → title; a missing column errors, no match continues.
    let lastError = "",
      empty: string | undefined;
    for (const sql of recordSearchQueries(args.recordType, args.query)) {
      try {
        const { rows, totalCount } = await runner.query(sql);
        if (!rows.length) {
          empty ??= sql;
          continue;
        }
        return {
          recordType: args.recordType.toLowerCase(),
          query: args.query ?? null,
          matched: totalCount ?? rows.length,
          records: rows.slice(0, args.limit).map((row) => ({ ...summarizeRecord(row), raw: row })),
          sql,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (empty) return { recordType: args.recordType.toLowerCase(), query: args.query ?? null, matched: 0, records: [], sql: empty };
    throw Object.assign(
      new Error(`Could not search ${args.recordType}: ${lastError}. Check the record type and its columns with orvane_netsuite_schema.`),
      { code: "INVALID_QUERY" },
    );
  }
  // logs
  const now = Date.now();
  const from = args.from ?? new Date(now - 7 * 24 * 3600 * 1000).toISOString();
  const to = args.to ?? new Date(now).toISOString();
  const page = await runner.page("log-search", {
    from,
    to,
    levels: (args.levels ?? []).filter((level: string) => LEVEL_SET.has(level)),
    scriptIds: args.scriptIds ?? [],
    deploymentIds: args.deploymentIds ?? [],
  });
  const rows: Record<string, any>[] = [...(page.rows ?? [])].sort(
    (a, b) => (Date.parse(b.datetime) || 0) - (Date.parse(a.datetime) || 0) || Number(b.id) - Number(a.id),
  );
  return {
    from,
    to,
    ...filterLogs(rows, { ...args, from, to } as any, Number(page.totalCount ?? rows.length)),
  };
}
