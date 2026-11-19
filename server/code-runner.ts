import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolRegistry } from "./tool-registry.ts";

// code_run: JavaScript that calls Orvane tools, run in a separate locked-down
// Node process (see code-sandbox.mjs). The code filters and transforms data
// there; only what it returns and logs comes back to the agent.

const sandbox = fileURLToPath(new URL("./code-sandbox.mjs", import.meta.url));
export const RESULT_LIMIT = 60_000;
const LOG_LIMIT = 8_000;
const CALL_LIMIT = 500;

export const codeSchema = {
  code: z
    .string()
    .min(1)
    .max(100_000)
    .describe(
      "Body of an async function. Call tools with await tools.app_list({}) or await tools.call(\"name\", args); read values from input; console.log for notes; return the value to send back (JSON).",
    ),
  input: z.record(z.string(), z.unknown()).default({}).describe("Values available as input.name."),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
};
const blocked = new Set(["code_run"]);

export function runCode(
  registry: ToolRegistry,
  code: string,
  input: Record<string, unknown>,
  timeoutSeconds = 60,
) {
  return new Promise<{ result: unknown; logs: string[]; toolCalls: number }>(
    (resolve, reject) => {
      const child = fork(sandbox, [], {
        execArgv: ["--permission", `--allow-fs-read=${sandbox}`],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        serialization: "json",
      });
      const logs: string[] = [];
      let logChars = 0,
        calls = 0,
        finished = false,
        stderr = "";
      const finish = (error?: Error, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill();
        if (error) reject(error);
        else resolve({ result: value, logs, toolCalls: calls });
      };
      const timer = setTimeout(
        () => finish(Error(`Code stopped after ${timeoutSeconds} s. Tool calls it made before that stay applied.`)),
        timeoutSeconds * 1000,
      );
      child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      child.on("error", (error) => finish(error));
      child.on("exit", (codeNumber) =>
        finish(Error(`Code process ended (${codeNumber}). ${stderr.trim()}`.trim())),
      );
      child.on("message", async (message: Record<string, string | number>) => {
        if (message.type === "ready")
          child.send({ type: "run", code, inputJson: JSON.stringify(input) });
        else if (message.type === "log") {
          const text = String(message.text);
          if (logChars < LOG_LIMIT) logs.push(text.slice(0, LOG_LIMIT - logChars));
          logChars += text.length;
        } else if (message.type === "call") {
          const reply = (error: string | null, value?: unknown) =>
            !finished &&
            child.send({ type: "result", id: message.id, error, json: JSON.stringify(value ?? null) });
          const name = String(message.name);
          if (++calls > CALL_LIMIT) return reply(`More than ${CALL_LIMIT} tool calls in one run.`);
          if (blocked.has(name)) return reply("code_run cannot start another code_run.");
          try {
            reply(null, await registry.call(name, JSON.parse(String(message.argsJson))));
          } catch (error) {
            reply(error instanceof Error ? error.message : String(error));
          }
        } else if (message.type === "done") {
          if (message.error !== undefined) finish(Error(String(message.error)));
          else {
            const json = String(message.json);
            if (json.length > RESULT_LIMIT)
              finish(
                Error(
                  `The returned value is ${json.length} characters; the limit is ${RESULT_LIMIT}. Return a smaller summary.`,
                ),
              );
            else finish(undefined, JSON.parse(json));
          }
        }
      });
    },
  );
}
