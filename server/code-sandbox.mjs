// Child process for code_run. Started with Node's permission model (no file
// writes, no reads beyond this file, no child processes or workers), and the
// agent's code runs inside a fresh vm context that only sees `tools`,
// `input` and `console`. Values cross the boundary as JSON strings so no
// object from this realm is reachable from the code.
import vm from "node:vm";

const send = (message) => process.send?.(message);
let nextCall = 0;
const pending = new Map();
process.on("message", (message) => {
  if (message?.type === "result") {
    const reply = pending.get(message.id);
    pending.delete(message.id);
    reply?.(message.error ?? null, message.json ?? "null");
    return;
  }
  if (message?.type === "run") run(message);
});

function run({ code, inputJson }) {
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  context.__call = (name, argsJson, reply) => {
    const id = ++nextCall;
    pending.set(id, (error, json) => reply(error === null ? null : String(error), String(json)));
    send({ type: "call", id, name: String(name), argsJson: String(argsJson) });
  };
  context.__log = (text) => send({ type: "log", text: String(text) });
  context.__done = (error, json) =>
    send(error === null ? { type: "done", json: String(json) } : { type: "done", error: String(error) });
  context.__input = String(inputJson);
  // Compiled on its own so the code cannot reach the bootstrap's variables
  // (which hold the functions above).
  try {
    context.__user = vm.compileFunction(
      "return (async () => {\n" + code + "\n})();",
      ["tools", "input", "console"],
      { parsingContext: context, filename: "code_run" },
    );
  } catch (error) {
    send({ type: "done", error: String(error?.stack || error) });
    return;
  }
  const bootstrap = `"use strict";
(() => {
  const call = globalThis.__call, log = globalThis.__log, done = globalThis.__done, user = globalThis.__user;
  const P = Promise, parse = JSON.parse, stringify = JSON.stringify, E = Error;
  const input = parse(globalThis.__input);
  delete globalThis.__call; delete globalThis.__log; delete globalThis.__done; delete globalThis.__input; delete globalThis.__user;
  const format = (v) => typeof v === "string" ? v : (() => { try { return stringify(v); } catch { return String(v); } })();
  const write = (...values) => log(values.map(format).join(" "));
  const callTool = (name, args) => new P((resolve, reject) => {
    let json;
    try { json = stringify(args === undefined ? {} : args); } catch (e) { reject(new E("Tool arguments must be JSON.")); return; }
    call(String(name), json, (error, result) => error === null ? resolve(parse(result)) : reject(new E(error)));
  });
  const tools = new Proxy(Object.create(null), {
    get: (_, name) => typeof name !== "string" ? undefined
      : name === "call" ? callTool
      : name === "then" ? undefined
      : (args) => callTool(name, args),
  });
  Object.defineProperty(globalThis, "tools", { value: tools });
  Object.defineProperty(globalThis, "input", { value: input });
  Object.defineProperty(globalThis, "console", { value: Object.freeze({ log: write, info: write, warn: write, error: write }) });
  P.resolve()
    .then(() => user(tools, input, globalThis.console))
    .then(
      (value) => { let json; try { json = stringify(value === undefined ? null : value); } catch (e) { done("The returned value is not JSON: " + e.message); return; } done(null, json); },
      (error) => done(String(error && error.stack ? error.stack : error)),
    );
})();`;
  try {
    vm.runInContext(bootstrap, context, { timeout: 10_000, filename: "code_run" });
  } catch (error) {
    send({ type: "done", error: String(error?.stack || error) });
  }
}
send({ type: "ready" });
