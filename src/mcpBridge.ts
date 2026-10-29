import { batchSchema, type Command } from "./automation";
import { uid } from "./model";

export type BridgeRequest = {
  commands?: Command[];
  recovery?: "preview" | "restore";
};
export function connectMcpBridge(options: {
  writable: () => boolean;
  revision: () => number;
  execute: (
    command: BridgeRequest,
    revision: string,
    expected?: string,
  ) => Promise<unknown>;
}) {
  const id = uid();
  let socket: WebSocket | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    closed = false;
  let queue = Promise.resolve();
  const responses = new Map<string, string>();
  const revision = () => `${id}:${options.revision()}`;
  function schedule() {
    if (!closed) timer = setTimeout(() => void connect(), 2000);
  }
  async function connect() {
    if (closed) return;
    if (!options.writable()) {
      schedule();
      return;
    }
    try {
      const response = await fetch("/__orvane/mcp", {
        cache: "no-store",
        credentials: "same-origin",
      });
      // A static deployment has no local MCP discovery endpoint.
      if (response.status === 404) return;
      if (!response.ok) {
        schedule();
        return;
      }
      const config = await response.json();
      if (!config.available) {
        schedule();
        return;
      }
      const url = new URL(config.url);
      if (
        url.protocol !== "ws:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/workspace" ||
        typeof config.token !== "string" ||
        !options.writable() ||
        closed
      ) {
        schedule();
        return;
      }
      socket = new WebSocket(url, ["orvane", config.token]);
      const connection = socket;
      connection.onopen = () => {
        if (!options.writable() || closed) {
          connection.close();
          return;
        }
        connection.send(
          JSON.stringify({
            type: "hello",
            session: {
              id,
              origin: location.origin,
              title: document.title || "Orvane",
            },
          }),
        );
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        if (socket === connection) socket = undefined;
        schedule();
      };
      connection.onmessage = (event) => {
        queue = queue
          .then(async () => {
            let request: {
              type: string;
              id: string;
              command: BridgeRequest;
              expectedRevision?: string;
            };
            try {
              request = JSON.parse(String(event.data));
            } catch {
              return;
            }
            if (request.type !== "command" || typeof request.id !== "string")
              return;
            const cached = responses.get(request.id);
            if (cached) {
              if (connection.readyState === WebSocket.OPEN)
                connection.send(cached);
              return;
            }
            let reply: unknown;
            try {
              if (closed || !options.writable())
                throw Error(
                  "This tab no longer owns editing. Call workspace_status to find the editing tab.",
                );
              if (
                request.expectedRevision !== undefined &&
                request.expectedRevision !== revision()
              )
                throw Error(
                  "The workspace changed since it was read. Read it again before applying this edit.",
                );
              if (request.command.commands)
                request.command.commands = batchSchema.parse(
                  request.command.commands,
                );
              else if (
                request.command.recovery !== "preview" &&
                request.command.recovery !== "restore"
              )
                throw Error("Invalid MCP command.");
              const data = await options.execute(
                request.command,
                revision(),
                request.expectedRevision,
              );
              reply = {
                type: "result",
                id: request.id,
                ok: true,
                data: { revision: revision(), ...(data as object) },
              };
            } catch (error) {
              reply = {
                type: "result",
                id: request.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
            const serialized = JSON.stringify(reply);
            const remembered =
              serialized.length <= 128000
                ? serialized
                : JSON.stringify({
                    type: "result",
                    id: request.id,
                    ok: false,
                    error:
                      "This request was already processed. Its large response was not cached; read the current workspace with a new request instead of replaying a mutation.",
                  });
            responses.set(request.id, remembered);
            if (responses.size > 50)
              responses.delete(responses.keys().next().value!);
            if (connection.readyState === WebSocket.OPEN)
              connection.send(serialized);
          })
          .catch(() => {
            /* Every command has its own error response; keep the queue usable. */
          });
      };
    } catch {
      schedule();
    }
  }
  void connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
