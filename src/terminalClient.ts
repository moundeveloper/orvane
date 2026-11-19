// One WebSocket to the local terminal server (server/terminal.ts), shared by
// every Terminal pane on the page. Sessions are keyed by pane id; after a
// dropped connection (or a reload) each pane opens again and the server
// re-attaches it to its running shell, replaying recent output.

export interface TerminalProfileInfo {
  id: string;
  name: string;
  kind: "cmd" | "powershell" | "bash" | "wsl" | "other";
  source: "detected" | "windows-terminal" | "visual-studio";
}
export interface SessionListener {
  /** A new shell started (the server had no session with this id). */
  started(name: string): void;
  /** Re-attached to a running shell: its recent output. */
  attached(replay: string): void;
  pin(path: string): void;
  output(data: string): void;
  exit(code: number): void;
  error(message: string): void;
}
interface Opening {
  profile: string;
  cwd?: string;
  cols: number;
  rows: number;
}

let socket: WebSocket | undefined;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Map<string, SessionListener>();
const openings = new Map<string, Opening>();

function send(message: Record<string, unknown>) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function connect() {
  if (socket && socket.readyState <= WebSocket.OPEN) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/__orvane/terminal`);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    for (const [id, o] of openings) send({ t: "open", id, ...o });
  };
  ws.onmessage = (event) => {
    let message: { t: string; id: string; d?: string; replay?: string; code?: number; name?: string; message?: string; path?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const listener = listeners.get(message.id);
    if (!listener) return;
    if (message.t === "o") listener.output(message.d ?? "");
    else if (message.t === "attached") listener.attached(message.replay ?? "");
    else if (message.t === "started") listener.started(message.name ?? "");
    else if (message.t === "pin" && typeof message.path === "string") listener.pin(message.path);
    else if (message.t === "exit") listener.exit(Number(message.code ?? 0));
    else if (message.t === "error") listener.error(message.message ?? "The terminal failed.");
  };
  ws.onclose = () => {
    if (socket === ws) socket = undefined;
    if (!listeners.size) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, Math.min(5000, 300 * 2 ** retry++));
  };
}

export const terminal = {
  open(id: string, opening: Opening, listener: SessionListener) {
    listeners.set(id, listener);
    openings.set(id, opening);
    if (socket?.readyState === WebSocket.OPEN) send({ t: "open", id, ...opening });
    else connect();
  },
  /** Hand a live session's output to a new listener without re-attaching. */
  listen(id: string, listener: SessionListener) {
    if (openings.has(id)) listeners.set(id, listener);
  },
  input(id: string, data: string) {
    send({ t: "in", id, d: data });
  },
  resize(id: string, cols: number, rows: number) {
    const o = openings.get(id);
    if (o) Object.assign(o, { cols, rows });
    send({ t: "resize", id, cols, rows });
  },
  /** The pane goes away but its shell keeps running (e.g. app unmounted). */
  detach(id: string) {
    listeners.delete(id);
    openings.delete(id);
    send({ t: "detach", id });
  },
  /** End the shell. */
  kill(id: string) {
    listeners.delete(id);
    openings.delete(id);
    send({ t: "kill", id });
  },
};

let profiles: Promise<TerminalProfileInfo[]> | undefined;
export function terminalProfiles(refresh = false) {
  if (!profiles || refresh)
    profiles = fetch("/__orvane/terminal/profiles")
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((data: { profiles?: TerminalProfileInfo[] }) => data.profiles ?? [])
      .catch(() => {
        profiles = undefined;
        return [];
      });
  return profiles;
}
