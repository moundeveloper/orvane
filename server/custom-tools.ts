import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LocalDatabase } from "./database.ts";
import { chainSchema, runChain } from "./chain.ts";
import { codeSchema, runCode } from "./code-runner.ts";
import type { ToolRegistry } from "./tool-registry.ts";

// Custom tools: a chain of tool calls or a piece of code, saved under a name
// and exposed as its own MCP tool (custom_<name>). Stored in the workspace
// SQLite (app_data "mcp:tools") so every connected agent sees the same set;
// each MCP process picks up changes within a few seconds.

const KEY = "mcp:tools";
const PREFIX = "custom_";
const paramType = z.enum(["string", "number", "boolean", "object", "array", "any"]);
const definition = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,40}$/, "Use lowercase letters, digits and _, starting with a letter.")
      .refine((n) => !n.startsWith("tool_"), "Names cannot start with tool_."),
    description: z.string().min(1).max(2000),
    params: z
      .record(
        z.string().regex(/^[A-Za-z_]\w{0,40}$/),
        z
          .object({
            type: paramType.default("string"),
            description: z.string().max(500).optional(),
            optional: z.boolean().optional(),
          })
          .strict(),
      )
      .default({}),
    steps: chainSchema.steps.optional(),
    return: chainSchema.return,
    code: codeSchema.code.optional(),
    timeoutSeconds: codeSchema.timeoutSeconds.optional(),
  })
  .strict()
  .refine((d) => !d.steps !== !d.code, "Give either steps (a chain) or code.");
type Definition = z.infer<typeof definition>;
export const customToolSchema = definition;

function inputShape(d: Definition) {
  const types = {
    string: z.string(),
    number: z.number(),
    boolean: z.boolean(),
    object: z.record(z.string(), z.unknown()),
    array: z.array(z.unknown()),
    any: z.unknown(),
  };
  return Object.fromEntries(
    Object.entries(d.params).map(([name, p]) => {
      let schema: z.ZodType = types[p.type];
      if (p.description) schema = schema.describe(p.description);
      return [name, p.optional ? schema.optional() : schema];
    }),
  );
}

export function registerCustomTools(
  server: McpServer,
  registry: ToolRegistry,
  dataDir: string,
  guarded: (callback: () => Promise<unknown>) => Promise<unknown>,
) {
  let db: LocalDatabase | undefined;
  const database = () => (db ||= new LocalDatabase(join(dataDir, "workspace.sqlite")));
  const read = () => ((database().appData(KEY) as { tools?: Definition[] } | undefined)?.tools ?? []);
  const live = new Map<string, { json: string; remove(): void }>();

  const run = (d: Definition, input: Record<string, unknown>) =>
    d.steps
      ? runChain(registry, d.steps, input, d.return)
      : runCode(registry, d.code!, input, d.timeoutSeconds);

  function sync() {
    let tools: Definition[];
    try {
      tools = read();
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const d of tools) {
      seen.add(d.name);
      const json = JSON.stringify(d);
      if (live.get(d.name)?.json === json) continue;
      live.get(d.name)?.remove();
      const handle = server.registerTool(
        PREFIX + d.name,
        {
          description: `[Custom tool] ${d.description}`,
          inputSchema: inputShape(d),
          annotations: { destructiveHint: true, openWorldHint: false },
        },
        async (args: Record<string, unknown>) =>
          guarded(async () => run(d, args)) as never,
      );
      live.set(d.name, { json, remove: () => handle.remove() });
    }
    for (const [name, entry] of live)
      if (!seen.has(name)) {
        entry.remove();
        live.delete(name);
      }
  }

  function check(d: Definition) {
    for (const [i, step] of (d.steps || []).entries())
      if (!registry.has(step.tool) && step.tool !== PREFIX + d.name)
        throw Error(`Step ${i + 1} uses unknown tool ${step.tool}.`);
    if (d.steps?.some((s) => s.tool === PREFIX + d.name))
      throw Error("A custom tool cannot call itself.");
  }

  server.registerTool(
    "custom_tool_list",
    {
      description:
        "List saved custom tools (chains and code saved under a name). Each is also exposed as its own tool custom_<name>.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guarded(async () => read()) as never,
  );
  server.registerTool(
    "custom_tool_save",
    {
      description:
        "Save a reusable tool: either steps (a tools_chain, args may use {{input.param}}) or code (a code_run body that reads input.param). It appears as custom_<name> for every connected agent within a few seconds, with params as its arguments. Saving an existing name replaces it. Test it first with tools_chain or code_run.",
      inputSchema: { tool: definition },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ tool }: { tool: Definition }) =>
      guarded(async () => {
        check(tool);
        const tools = read().filter((t) => t.name !== tool.name);
        if (tools.length >= 200) throw Error("At most 200 custom tools.");
        database().saveAppData(KEY, { tools: [...tools, tool] });
        sync();
        return { saved: PREFIX + tool.name, kind: tool.steps ? "chain" : "code" };
      }) as never,
  );
  server.registerTool(
    "custom_tool_delete",
    {
      description: "Delete a saved custom tool by name (without the custom_ prefix).",
      inputSchema: { name: z.string().min(1) },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ name }: { name: string }) =>
      guarded(async () => {
        const tools = read();
        if (!tools.some((t) => t.name === name)) throw Error(`No custom tool named ${name}.`);
        database().saveAppData(KEY, { tools: tools.filter((t) => t.name !== name) });
        sync();
        return { deleted: PREFIX + name };
      }) as never,
  );
  server.registerTool(
    "custom_tool_run",
    {
      description:
        "Run a saved custom tool by name with its params. Same as calling custom_<name>; use it when your client has not refreshed its tool list yet.",
      inputSchema: {
        name: z.string().min(1),
        input: z.record(z.string(), z.unknown()).default({}),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ name, input }: { name: string; input: Record<string, unknown> }) =>
      guarded(async () => {
        const d = read().find((t) => t.name === name);
        if (!d) throw Error(`No custom tool named ${name}. Call custom_tool_list.`);
        const parsed = z.object(inputShape(d)).strict().parse(input);
        return run(d, parsed);
      }) as never,
  );
  sync();
  const timer = setInterval(sync, 3000);
  timer.unref();
  return () => {
    clearInterval(timer);
    db?.close();
  };
}
