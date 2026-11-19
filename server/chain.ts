import { z } from "zod";
import { readPath, type ToolRegistry } from "./tool-registry.ts";

// tools_chain: run tool calls one after another inside the server. Later
// arguments reference earlier results with {{name.path}}; only the value the
// chain returns goes back to the agent.

export const chainStep = z
  .object({
    tool: z.string().min(1).describe("Name of any Orvane tool."),
    args: z.unknown().optional().describe('Arguments. Strings may use {{input.x}} or {{stepName.path[0].field}}; a string that is only one {{...}} is replaced by that value as-is (object, number, list).'),
    as: z
      .string()
      .regex(/^[A-Za-z_]\w{0,40}$/)
      .optional()
      .describe("Name for this step's result (default step1, step2 ...)."),
  })
  .strict();
export const chainSchema = {
  steps: z.array(chainStep).min(1).max(50),
  input: z.record(z.string(), z.unknown()).default({}).describe("Values available as {{input.name}}."),
  return: z
    .string()
    .optional()
    .describe('What to return, e.g. "{{step2.apps[0].id}}" or a template "{{a.count}} items". Default: the last step result.'),
};
export type ChainStep = z.infer<typeof chainStep>;

const whole = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const part = /\{\{\s*([^{}]+?)\s*\}\}/g;
function resolve(value: unknown, scope: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const only = value.match(whole);
    if (only) return lookup(only[1]!, scope);
    return value.replace(part, (_, path: string) => {
      const found = lookup(path, scope);
      return typeof found === "string" ? found : JSON.stringify(found ?? null);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolve(v, scope));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolve(v, scope)]),
    );
  return value;
}
function lookup(path: string, scope: Record<string, unknown>) {
  const [head] = path.match(/^[^.[\]]+/) || [""];
  if (!(head in scope)) throw Error(`{{${path}}}: no input or earlier step named ${head}.`);
  return readPath(scope, path);
}

export async function runChain(
  registry: ToolRegistry,
  steps: ChainStep[],
  input: Record<string, unknown>,
  returns?: string,
) {
  const scope: Record<string, unknown> = { input };
  const done: { as: string; tool: string; chars: number }[] = [];
  let last: unknown;
  for (const [i, step] of steps.entries()) {
    const name = step.as || `step${i + 1}`;
    if (name === "input" || name in scope)
      throw Error(`Step ${i + 1}: the name ${name} is already used.`);
    if (step.tool === "tools_chain")
      throw Error(`Step ${i + 1}: a chain cannot contain tools_chain; add the steps directly.`);
    let args: unknown;
    try {
      args = resolve(step.args ?? {}, scope);
      last = await registry.call(step.tool, args);
    } catch (error) {
      throw Error(
        `Step ${i + 1} (${step.tool}) failed: ${error instanceof Error ? error.message : String(error)}. Steps before it completed and stay applied.`,
      );
    }
    scope[name] = last;
    done.push({ as: name, tool: step.tool, chars: JSON.stringify(last ?? null).length });
  }
  return {
    result: returns === undefined ? last : resolve(returns, scope),
    steps: done,
  };
}
