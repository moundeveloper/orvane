import { z } from "zod";

// Versioned, implementation-owned policies. No caller-supplied SQL or effect flags.
export const netSuiteReadOperations = Object.freeze({
  scripts: { capability: "read.scripts", id: "forbidden" },
  deployments: { capability: "read.deployments", id: "script" },
  folders: { capability: "read.folders", id: "optional-folder" },
  files: { capability: "read.files", id: "folder" },
  "find-files": { capability: "read.find-files", id: "optional-file" },
  "find-folders": {
    capability: "read.find-folders",
    id: "optional-folder-search",
  },
} as const);

export const NETSUITE_FILTER_CAPABILITY = "read.filters-v1";
const filterText = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (value) => !/[\u0000-\u001f\u007f;]/.test(value),
    "Filters cannot contain control characters or semicolons.",
  );
const filtersSchema = z
  .object({
    name: filterText.optional(),
    scriptId: filterText.optional(),
    scriptType: filterText.optional(),
    owner: filterText.optional(),
  })
  .strict()
  .refine(
    (filters) => Object.values(filters).some((value) => value !== undefined),
    "Choose at least one filter.",
  );
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const contains = (column: string, value: string) =>
  `INSTR(LOWER(${column}), LOWER(${literal(value)})) > 0`;

export const netSuiteReadSchema = z
  .object({
    action: z.enum([
      "scripts",
      "deployments",
      "folders",
      "files",
      "find-files",
      "find-folders",
    ]),
    targetId: z.string().min(1).max(100),
    identityToken: z.string().min(1).max(100),
    id: z
      .number()
      .int()
      .min(Number.MIN_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .refine((id) => id !== 0, "ID cannot be zero")
      .optional(),
    page: z.number().int().min(0).max(10000).default(0),
    shareInFlight: z.boolean().default(false),
    filters: filtersSchema.optional(),
  })
  .strict();

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_READ" });
}

export function compileNetSuiteRead(request: unknown) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    invalid("A typed read request is required.");
  const { operation, ...input } = request as Record<string, unknown>;
  if (operation !== "read") invalid("A typed read operation is required.");
  const parsed = netSuiteReadSchema.safeParse(input);
  if (!parsed.success)
    invalid(
      "Use a known read action, explicit target/identity, a valid ID and page 0–10000; unknown fields are rejected.",
    );
  const args = parsed.data;
  const policy = netSuiteReadOperations[args.action];
  if (policy.id === "forbidden" && args.id !== undefined)
    invalid("The scripts action does not accept an ID.");
  if (
    (policy.id === "script" || policy.id === "folder") &&
    args.id === undefined
  )
    invalid("deployments requires a script ID; files requires a folder ID.");
  if (policy.id === "script" && args.id! < 1)
    invalid("Choose a positive script ID.");
  if (policy.id === "optional-file" && args.id !== undefined && args.id < 1)
    invalid("Choose a positive File Cabinet file ID.");
  const filterFields = Object.entries(args.filters ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([field]) => field)
    .sort();
  if (args.action === "deployments" && filterFields.length)
    invalid("Deployment reads do not accept filters.");
  if (
    args.action !== "scripts" &&
    filterFields.some((field) => field !== "name")
  )
    invalid("Only scripts support scriptId, scriptType and owner filters.");
  if (
    ["find-files", "find-folders"].includes(args.action) &&
    args.id === undefined &&
    !args.filters?.name
  )
    invalid(
      "Global search requires an exact File Cabinet ID or a name filter.",
    );
  const predicates: string[] = [];
  const filters = args.filters;
  if (args.action === "scripts") {
    if (filters?.scriptId)
      predicates.push(`script.scriptid = ${literal(filters.scriptId)}`);
    if (filters?.scriptType)
      predicates.push(
        `UPPER(script.scripttype) = UPPER(${literal(filters.scriptType)})`,
      );
    if (filters?.name) predicates.push(contains("script.name", filters.name));
    if (filters?.owner)
      predicates.push(contains("entity.entityid", filters.owner));
  } else if (filters?.name) predicates.push(contains("name", filters.name));
  const where = (base?: string) => {
    const all = [...(base ? [base] : []), ...predicates];
    return all.length ? ` WHERE ${all.join(" AND ")}` : "";
  };
  let sql: string;
  switch (args.action) {
    case "scripts":
      sql = `SELECT script.id, script.scriptid, script.name, script.scripttype, entity.entityid AS owner, file.name AS scriptfile, file.id AS fileid FROM script LEFT JOIN entity ON script.owner = entity.id LEFT JOIN file ON file.id = script.scriptfile${where()} ORDER BY script.name, script.id`;
      break;
    case "deployments":
      sql = `SELECT scriptDeployment.scriptid, scriptDeployment.recordtype, scriptDeployment.isdeployed, scriptDeployment.status, scriptDeployment.loglevel, scriptDeployment.primarykey, scriptDeployment.deploymentid FROM scriptdeployment WHERE script = ${args.id} ORDER BY scriptDeployment.scriptid, scriptDeployment.primarykey`;
      break;
    case "folders":
      sql = `SELECT id, name, parent, foldertype, numfolderfiles, foldersize, lastmodifieddate, description FROM MediaItemFolder${where(args.id === undefined ? "IsTopLevel = 'T'" : `parent = ${args.id}`)} ORDER BY name, id`;
      break;
    case "files":
      sql = `SELECT id, name, filesize, filetype, folder, lastmodifieddate, createddate, description FROM file${where(`folder = ${args.id}`)} ORDER BY name, id`;
      break;
    case "find-files":
      sql = `SELECT id, name, filesize, filetype, folder, lastmodifieddate, createddate, description FROM file${where(args.id === undefined ? undefined : `id = ${args.id}`)} ORDER BY name, id`;
      break;
    case "find-folders":
      sql = `SELECT id, name, parent, foldertype, numfolderfiles, foldersize, lastmodifieddate, description FROM MediaItemFolder${where(args.id === undefined ? undefined : `id = ${args.id}`)} ORDER BY name, id`;
      break;
  }
  return {
    args,
    sql,
    offset: args.page * 100,
    policy: {
      schemaVersion: 2,
      effect: "read",
      executor: "processing",
      retry: "neverAutomatic",
      cache: "none",
      capability: policy.capability,
    } as const,
    descriptor: {
      schemaVersion: 2,
      action: args.action,
      id: args.id ?? null,
      page: args.page,
      pageSize: 100,
      pagination: "live-offset" as const,
      filterFields,
    },
  };
}
