import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Keeps every tool this server registers so tools_chain, code_run and custom
// tools can call them in-process. Data that flows between those calls never
// reaches the agent's context; only the final value does.

type Handler = (args: Record<string, unknown>, extra: unknown) => unknown;
type Entry = { schema: z.ZodType; handler: Handler };
type ToolResult = {
  isError?: boolean;
  content?: { type: string; text?: string; mimeType?: string; data?: string }[];
  structuredContent?: Record<string, unknown>;
};

/** Nesting depth of internal calls (code -> custom tool -> chain ...). */
const depth = new AsyncLocalStorage<number>();
export const MAX_DEPTH = 4;

export function createToolRegistry(server: McpServer) {
  const tools = new Map<string, Entry>();
  const register = server.registerTool.bind(server);
  // Wrapping before any tool is registered captures every module's tools.
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: { inputSchema?: unknown },
    handler: Handler,
  ) => {
    const shape = config.inputSchema;
    const schema =
      shape && typeof (shape as z.ZodType).safeParseAsync === "function"
        ? (shape as z.ZodType)
        : z.object((shape || {}) as z.ZodRawShape);
    tools.set(name, { schema, handler });
    const registered = (register as (...a: unknown[]) => { remove(): void })(
      name,
      config,
      handler,
    );
    const remove = registered.remove.bind(registered);
    registered.remove = () => {
      tools.delete(name);
      remove();
    };
    return registered;
  };

  /** Call a registered tool and return its plain value; throws its error. */
  async function call(name: string, args: unknown = {}) {
    const level = (depth.getStore() ?? 0) + 1;
    if (level > MAX_DEPTH)
      throw Error(`Tools may nest at most ${MAX_DEPTH} levels (code, chains and custom tools calling each other).`);
    const tool = tools.get(name);
    if (!tool) throw Error(`Unknown tool ${name}.`);
    const parsed = await tool.schema.safeParseAsync(args ?? {});
    if (!parsed.success)
      throw Error(`${name}: invalid arguments: ${z.prettifyError(parsed.error)}`);
    const controller = new AbortController();
    const output = (await depth.run(level, () =>
      tool.handler(parsed.data as Record<string, unknown>, {
        signal: controller.signal,
        requestId: `internal-${name}`,
        sendNotification: async () => {},
        sendRequest: async () => {
          throw Error("Nested tools cannot ask the client for input.");
        },
      }),
    )) as ToolResult;
    return unwrap(name, output);
  }
  return {
    call,
    names: () => [...tools.keys()],
    has: (name: string) => tools.has(name),
  };
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>;

function unwrap(name: string, output: ToolResult) {
  const text = (output.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
  if (output.isError) throw Error(`${name}: ${text || "failed"}`);
  const structured = output.structuredContent;
  if (structured && "result" in structured) return structured.result;
  if (structured) return structured;
  const images = (output.content || []).filter((c) => c.type === "image");
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {}
  return images.length
    ? { text: value, images: images.map((i) => ({ mimeType: i.mimeType, bytes: Math.round(((i.data || "").length * 3) / 4) })) }
    : value;
}

/** Read a.b[0].c from a value. */
export function readPath(value: unknown, path: string) {
  const parts = path.match(/[^.[\]]+/g) || [];
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
