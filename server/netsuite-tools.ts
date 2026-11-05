import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  desktopNetSuiteRequest,
  DesktopNetSuiteError,
} from "./netsuite-client.ts";

export function registerNetSuiteTools(server: McpServer, directory: string) {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  });
  async function call(request: object, disconnectedStatus = false) {
    try {
      return result(await desktopNetSuiteRequest(directory, request));
    } catch (error) {
      const code =
        error instanceof DesktopNetSuiteError ? error.code : "NETSUITE_ERROR";
      const message = error instanceof Error ? error.message : String(error);
      if (disconnectedStatus && code === "DESKTOP_UNAVAILABLE")
        return result({ available: false, code, message, environments: [] });
      return {
        isError: true,
        content: [
          { type: "text" as const, text: JSON.stringify({ code, message }) },
        ],
      };
    }
  }
  server.registerTool(
    "orvane_netsuite_status",
    {
      description:
        "Read-only Orvane Desktop NetSuite status. list returns explicitly selectable environment target IDs; inspect requires a targetId and returns a client-runtime account/user/role identityToken required by query. No renderer or canvas editing lease is required. Client runtime identity does not verify a server-side Suitelet. Restart Desktop after installing a new batch.",
      inputSchema: {
        action: z.enum(["list", "inspect"]).default("list"),
        targetId: z.string().min(1).max(100).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    ({ action, targetId }) =>
      call({ operation: "status", action, targetId }, action === "list"),
  );
  server.registerTool(
    "orvane_netsuite_query",
    {
      description:
        "Execute one bounded SELECT through Orvane's internal-browser processing page. First list and inspect a target using orvane_netsuite_status. Pass that targetId and identityToken explicitly. Returns one existing-adapter page (100 rows), with a 1 MiB response cap. No writes, arbitrary JavaScript or automatic retries. Changed reported client-runtime identity discards results; this is not server-side session/role verification. Paging follows the existing adapter, not a materialized snapshot; use deterministic ORDER BY.",
      inputSchema: {
        targetId: z.string().min(1).max(100),
        identityToken: z.string().min(1).max(100),
        sql: z.string().min(1).max(20000),
        offset: z.number().int().min(0).max(1000000).default(0),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (args) => call({ operation: "query", ...args }),
  );
}
