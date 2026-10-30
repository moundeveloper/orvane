// Orvane's dev server for the desktop app, run on the system Node. It exits
// when the desktop app goes away, however it ended (its stdin pipe closes),
// so a crashed or killed window never leaves an orphaned server behind.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.argv[2]) || 5173;
const server = await createServer({
  root,
  server: { port, strictPort: true },
});
await server.listen();
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
