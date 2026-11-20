import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { desktopNetSuiteRequest, DesktopNetSuiteError } from "./netsuite-client.ts";
import { createSuiteCloudWorkspace } from "./suitecloud-workspace.ts";

// SDF rules (a copy of the sdf-object-builder skill, in server/sdf-guide/) and
// the per-account SuiteCloud workspace, exposed to agents in a few calls.

const GUIDE = fileURLToPath(new URL("./sdf-guide/", import.meta.url));
const TOPICS = {
  overview: "SKILL.md",
  scripts: "reference/scripts.md",
  "custom-fields": "reference/custom-fields.md",
  "custom-lists": "reference/custom-lists.md",
  "custom-records": "reference/custom-records.md",
} as const;
const ORVANE_NOTE =
  "In Orvane: build in the account's SuiteCloud workspace with orvane_netsuite_sdf (write files and objects in bulk, deploy, validate, import). Where this guide mentions the magic-netsuite MCP, use orvane_netsuite_sdf instead; the project root is the workspace (src/ = its defaultProjectFolder), so Step 0's project search is already done.";

export async function readSdfGuide(topic?: string, example?: string) {
  const examples = (await readdir(join(GUIDE, "examples"))).filter((name) => name.endsWith(".xml")).sort();
  if (example) {
    if (!examples.includes(example)) throw Error(`Unknown example. Available: ${examples.join(", ")}`);
    return { example, xml: await readFile(join(GUIDE, "examples", example), "utf8") };
  }
  if (!topic)
    return {
      note: ORVANE_NOTE,
      topics: Object.keys(TOPICS),
      examples,
      start: "Read topic overview first, then the topic for the object type you build, then one example as a template.",
    };
  const file = TOPICS[topic as keyof typeof TOPICS];
  if (!file) throw Error(`Unknown topic. Available: ${Object.keys(TOPICS).join(", ")}`);
  return { topic, note: ORVANE_NOTE, text: await readFile(join(GUIDE, file), "utf8") };
}

const pathText = z.string().min(1).max(500);
export const netSuiteSdfSchema = z
  .object({
    targetId: z.string().min(1).max(100),
    identityToken: z.string().min(1).max(100),
    action: z.enum(["status", "choose-auth", "tree", "read", "write", "deploy", "validate", "add-dependencies", "import-objects", "import-files", "list-objects"]),
    refresh: z.boolean().optional(),
    authId: z.string().min(1).max(100).optional(),
    under: pathText.optional(),
    paths: z.array(pathText).max(200).optional(),
    files: z.array(z.object({ path: pathText, content: z.string().max(2_000_000) }).strict()).max(200).optional(),
    edits: z
      .array(z.object({ path: pathText, find: z.string().min(1).max(100_000), replace: z.string().max(100_000), all: z.boolean().optional() }).strict())
      .max(500)
      .optional(),
    remove: z.array(pathText).max(200).optional(),
    scriptIds: z.array(z.string().min(1).max(100)).max(100).optional(),
    type: z.string().min(1).max(60).optional(),
    dryRun: z.boolean().optional(),
    maxChars: z.number().int().min(1000).max(400_000).optional(),
  })
  .strict();

export function registerSuiteCloudTools(server: McpServer, directory: string) {
  const workspace = createSuiteCloudWorkspace(directory);
  const ok = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  });
  const fail = (code: string, message: string) => ({
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ code, message }) }],
  });

  server.registerTool(
    "orvane_netsuite_sdf_guide",
    {
      description:
        "Rules for building NetSuite SDF objects without deploy errors (scripts and deployments, custom fields of every family, custom lists, custom record types), with XML templates. No arguments: the topic and example list. topic: overview | scripts | custom-fields | custom-lists | custom-records. example: one template file name. Read before writing objects in the SuiteCloud workspace.",
      inputSchema: { topic: z.string().max(40).optional(), example: z.string().max(100).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ topic, example }) => {
      try {
        return ok(await readSdfGuide(topic, example));
      } catch (error) {
        return fail("INVALID_GUIDE_TOPIC", error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "orvane_netsuite_sdf",
    {
      description:
        "The account's SuiteCloud workspace: a scratch SDF project Orvane keeps per NetSuite account, deployed with the SuiteCloud CLI and the account's authentication ID (connect it in NetSuite → SuiteCloud → Connect with certificate). Pass targetId + identityToken from orvane_netsuite_status. Paths are relative to the project's src folder (FileCabinet/SuiteScripts/…, Objects/…, deploy.xml, manifest.xml). Actions: status (available, why not, auth IDs; refresh after a new login) · choose-auth {authId} · tree {under?} · read {paths} · write {files:[{path,content}], edits:[{path,find,replace,all?}], remove:[paths]} (all in one call; an edit that does not match fails) · deploy {dryRun?} (deploys deploy.xml: by default all of FileCabinet and Objects) · validate (server-side) · add-dependencies (fills manifest.xml dependencies from what the project uses; run before the first deploy) · import-objects {scriptIds} (objects with their script files) · import-files {paths:['/SuiteScripts/…']} · list-objects {type?}. CLI output is trimmed to errors and the last lines. Read orvane_netsuite_sdf_guide before writing objects. Deploy changes the account.",
      inputSchema: netSuiteSdfSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      let accountId: string;
      try {
        const inspected = (await desktopNetSuiteRequest(directory, { operation: "status", action: "inspect", targetId: args.targetId })) as {
          identity?: { accountId?: string; identityToken?: string };
        };
        if (inspected.identity?.identityToken !== args.identityToken || !inspected.identity?.accountId)
          return fail("IDENTITY_CHANGED", "Inspect this target again; its account, user or role changed. Nothing was run.");
        accountId = inspected.identity.accountId;
      } catch (error) {
        return fail(error instanceof DesktopNetSuiteError ? error.code : "NETSUITE_ERROR", error instanceof Error ? error.message : String(error));
      }
      try {
        switch (args.action) {
          case "status":
            return ok(await workspace.status(accountId, args.refresh === true));
          case "choose-auth":
            if (!args.authId) return fail("INVALID_SDF", "choose-auth needs authId.");
            return ok(await workspace.chooseAuth(accountId, args.authId));
          case "tree":
            await workspace.ensure(accountId);
            return ok(await workspace.tree(accountId, args.under ?? ""));
          case "read":
            if (!args.paths?.length) return fail("INVALID_SDF", "read needs paths.");
            await workspace.ensure(accountId);
            return ok(await workspace.readFiles(accountId, args.paths, args.maxChars));
          case "write":
            if (!args.files?.length && !args.edits?.length && !args.remove?.length) return fail("INVALID_SDF", "write needs files, edits or remove.");
            await workspace.ensure(accountId);
            return ok(await workspace.writeFiles(accountId, args.files, args.edits, args.remove));
          default:
            return ok(
              await workspace.cli(accountId, args.action, {
                scriptIds: args.scriptIds,
                paths: args.paths,
                type: args.type,
                dryRun: args.dryRun,
              }),
            );
        }
      } catch (error) {
        return fail((error as { code?: string })?.code ?? "SDF_ERROR", error instanceof Error ? error.message : String(error));
      }
    },
  );
  return workspace;
}
