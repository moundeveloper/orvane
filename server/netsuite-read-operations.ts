import { z } from "zod";

// Versioned, implementation-owned policies. No caller-supplied SQL or effect flags.
export const netSuiteReadOperations = Object.freeze({
  scripts: { capability: "read.scripts", id: "forbidden" },
  deployments: { capability: "read.deployments", id: "script" },
  folders: { capability: "read.folders", id: "optional-folder" },
  files: { capability: "read.files", id: "folder" },
} as const);

export const netSuiteReadSchema = z
  .object({
    action: z.enum(["scripts", "deployments", "folders", "files"]),
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
  let sql: string;
  switch (args.action) {
    case "scripts":
      sql =
        "SELECT script.id, script.scriptid, script.name, script.scripttype, entity.entityid AS owner, file.name AS scriptfile, file.id AS fileid FROM script LEFT JOIN entity ON script.owner = entity.id LEFT JOIN file ON file.id = script.scriptfile ORDER BY script.name, script.id";
      break;
    case "deployments":
      sql = `SELECT scriptDeployment.scriptid, scriptDeployment.recordtype, scriptDeployment.isdeployed, scriptDeployment.status, scriptDeployment.loglevel, scriptDeployment.primarykey, scriptDeployment.deploymentid FROM scriptdeployment WHERE script = ${args.id} ORDER BY scriptDeployment.scriptid, scriptDeployment.primarykey`;
      break;
    case "folders":
      sql = `SELECT id, name, parent, foldertype, numfolderfiles, foldersize, lastmodifieddate, description FROM MediaItemFolder WHERE ${args.id === undefined ? "IsTopLevel = 'T'" : `parent = ${args.id}`} ORDER BY name, id`;
      break;
    case "files":
      sql = `SELECT id, name, filesize, filetype, folder, lastmodifieddate, createddate, description FROM file WHERE folder = ${args.id} ORDER BY name, id`;
      break;
  }
  return {
    args,
    sql,
    offset: args.page * 100,
    policy: {
      schemaVersion: 1,
      effect: "read",
      executor: "processing",
      retry: "neverAutomatic",
      cache: "none",
      capability: policy.capability,
    } as const,
    descriptor: {
      schemaVersion: 1,
      action: args.action,
      id: args.id ?? null,
      page: args.page,
      pageSize: 100,
      pagination: "live-offset" as const,
    },
  };
}
