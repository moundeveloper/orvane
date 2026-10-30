// Orvane's server for the desktop app, run on the system Node. It serves the
// production build (rebuilt when sources are newer) because the development
// build of Vue is markedly slower; ORVANE_DEV=1 keeps the hot-reload dev server.
// It exits when the desktop app goes away, however it ended (its stdin pipe
// closes), so a crashed or killed window never leaves an orphaned server behind.
import { build, createServer, preview } from "vite";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2]) || 5173;
function newest(path) {
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  return Math.max(
    info.mtimeMs,
    ...readdirSync(path).map((name) => newest(join(path, name))),
  );
}
function stale() {
  try {
    const built = statSync(join(root, "dist/index.html")).mtimeMs;
    return ["src", "public", "index.html", "vite.config.ts", "package.json"]
      .map((name) => join(root, name))
      .some((path) => {
        try {
          return newest(path) > built;
        } catch {
          return false;
        }
      });
  } catch {
    return true;
  }
}
let server;
if (process.env.ORVANE_DEV === "1") {
  server = await createServer({ root, server: { port, strictPort: true } });
  await server.listen();
} else {
  if (stale()) await build({ root, logLevel: "warn" });
  server = await preview({ root, preview: { port, strictPort: true } });
}
server.printUrls();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  // Closing can wait on connections from the dead window; don't linger.
  setTimeout(() => process.exit(0), 1500).unref();
  await server.close().catch(() => undefined);
  process.exit(0);
}
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();
// The pipe alone is not a reliable signal on Windows, so also watch the
// app's process id.
const parent = Number(process.argv[3]);
if (parent)
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      void stop();
    }
  }, 1000).unref();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
