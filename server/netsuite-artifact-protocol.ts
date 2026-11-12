import { z } from "zod";
import { netSuiteReadSchema } from "./netsuite-read-operations.ts";

export const ARTIFACT_CAPABILITY = "artifacts.page-v1";
export const ARTIFACT_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  quotaBytes: 16 * 1024 * 1024,
  maxArtifacts: 64,
  ttlMs: 24 * 60 * 60 * 1000,
  maxReadCharacters: 16000,
});
const query = z
  .object({
    kind: z.literal("query"),
    sql: z
      .string()
      .min(1)
      .max(20000)
      .regex(/^\s*select\b/i)
      .refine((sql) => !sql.includes(";")),
    offset: z.number().int().min(0).max(1000000).default(0),
    shareInFlight: z.boolean().default(false),
  })
  .strict();
const read = netSuiteReadSchema
  .omit({ targetId: true, identityToken: true })
  .extend({ kind: z.literal("read") });
export const netSuiteArtifactSchema = z
  .object({
    action: z.enum(["export", "inspect", "read"]),
    targetId: z.string().min(1).max(100),
    identityToken: z.string().min(1).max(100),
    source: z.discriminatedUnion("kind", [query, read]).optional(),
    format: z.enum(["csv", "ndjson"]).optional(),
    artifactId: z.uuid().optional(),
    offset: z.number().int().min(0).max(ARTIFACT_LIMITS.maxBytes).optional(),
    length: z
      .number()
      .int()
      .min(1)
      .max(ARTIFACT_LIMITS.maxReadCharacters)
      .optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (args.action === "export") {
      if (
        !args.source ||
        args.artifactId !== undefined ||
        args.offset !== undefined ||
        args.length !== undefined
      )
        bad(
          "Export requires source and does not accept an artifact ID or range.",
        );
    } else {
      if (
        !args.artifactId ||
        args.source !== undefined ||
        args.format !== undefined
      )
        bad(
          "Inspect/read require an artifact ID and do not accept source/format.",
        );
      if (
        args.action === "inspect" &&
        (args.offset !== undefined || args.length !== undefined)
      )
        bad("Inspect does not accept a range.");
    }
  });
export function validateNetSuiteArtifact(request: unknown) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw Object.assign(Error("Artifact request required."), {
      code: "INVALID_ARTIFACT_REQUEST",
    });
  const { operation, ...input } = request as Record<string, unknown>;
  const parsed = netSuiteArtifactSchema.safeParse(input);
  if (operation !== "artifact" || !parsed.success)
    throw Object.assign(
      Error(
        "Use export with a bounded source, or inspect/read with an artifact ID and valid optional range. Unknown fields are rejected.",
      ),
      { code: "INVALID_ARTIFACT_REQUEST" },
    );
  return parsed.data;
}
export const artifactOwnerSchema = z
  .object({
    origin: z.string().regex(/^https:\/\/[a-z0-9-]+\.app\.netsuite\.com$/i),
    accountId: z.string().min(1).max(100),
    userId: z.string().min(1).max(100),
    roleId: z.string().min(1).max(100),
  })
  .strict();
export const artifactMetadataSchema = z
  .object({
    version: z.literal(1),
    artifactId: z.uuid(),
    hash: z.string().regex(/^[a-f\d]{64}$/),
    sizeBytes: z.number().int().min(0).max(ARTIFACT_LIMITS.maxBytes),
    format: z.enum(["csv", "ndjson"]),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    owner: artifactOwnerSchema,
    source: z
      .object({
        kind: z.enum(["query", "read"]),
        action: z.string().max(30).nullable(),
        offset: z.number().int().nonnegative().max(1000000),
        rowCount: z.number().int().min(0).max(100),
        observedAt: z.string().datetime(),
        sessionEpoch: z.number().int().positive().nullable(),
      })
      .strict(),
  })
  .strict();
