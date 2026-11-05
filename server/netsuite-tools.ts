import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  netSuiteReadSchema,
  netSuiteReadOperations,
} from "./netsuite-read-operations.ts";
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
          {
            type: "text" as const,
            text: JSON.stringify({
              code,
              message,
              requestId:
                error instanceof DesktopNetSuiteError
                  ? error.requestId
                  : undefined,
            }),
          },
        ],
      };
    }
  }
  server.registerTool(
    "orvane_netsuite_status",
    {
      description:
        "Read-only Orvane Desktop NetSuite status. list returns environment target IDs; inspect requires targetId and returns client-runtime identityToken for query. requests reads bounded, redacted request history on brokers advertising requests.read (Batch 3+). Returns UPGRADE_PENDING on older active brokers. No renderer/canvas lease required. Session epochs fence observed source-page lifecycle changes; they do not verify server-side identity.",
      inputSchema: {
        action: z.enum(["list", "inspect", "requests"]).default("list"),
        targetId: z.string().min(1).max(100).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        beforeSequence: z.number().int().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ action, targetId, limit, beforeSequence }) => {
      if (action === "requests") {
        try {
          const status = (await desktopNetSuiteRequest(directory, {
            operation: "status",
            action: "list",
          })) as { capabilities?: string[] };
          if (!status.capabilities?.includes("requests.read"))
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    code: "UPGRADE_PENDING",
                    message:
                      "The running Desktop broker does not have request history yet. Existing reads remain available; no automatic restart was performed.",
                  }),
                },
              ],
            };
        } catch {
          return call({ operation: "status", action, limit, beforeSequence });
        }
      }
      return call(
        { operation: "status", action, targetId, limit, beforeSequence },
        action === "list",
      );
    },
  );
  server.registerTool(
    "orvane_netsuite_read",
    {
      description:
        "Read-only typed NetSuite lists (Batch 5+). First list/inspect a target. actions: scripts (no id); deployments (positive script id); folders (omit id for roots, or parent folder id); files (folder id required). Negative system folder IDs are allowed. Fixed SELECTs, stable name/id ordering, up to 100 rows per page; page starts at 0. Live offset paging is not a snapshot. Metadata only: no file contents, writes, arbitrary SQL or server identity verification. shareInFlight defaults false. Missing broker capability returns UPGRADE_PENDING without submitting a read.",
      inputSchema: netSuiteReadSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const status = (await desktopNetSuiteRequest(directory, {
          operation: "status",
          action: "list",
        })) as { capabilities?: string[] };
        if (
          !status.capabilities?.includes(
            netSuiteReadOperations[args.action].capability,
          )
        )
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: "UPGRADE_PENDING",
                  message:
                    "The running Desktop broker does not support this typed read. No read was submitted.",
                }),
              },
            ],
          };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                code:
                  error instanceof DesktopNetSuiteError
                    ? error.code
                    : "NETSUITE_ERROR",
                message:
                  "Typed-read capability could not be checked. No read was submitted.",
              }),
            },
          ],
        };
      }
      return call({ operation: "read", ...args });
    },
  );
  server.registerTool(
    "orvane_netsuite_query",
    {
      description:
        "Execute one bounded SELECT through Orvane's internal-browser processing page. First list and inspect a target using orvane_netsuite_status. Pass targetId and identityToken explicitly. Returns up to 100 rows, with a 1 MiB response cap. Optional shareInFlight (default false, Batch 4+) shares an identical currently running SELECT for the same target/identity/offset; use only when one observation may serve multiple callers. No completed-result cache, writes or automatic retries. Client-runtime identity checks are not server-side verification. Paging is not a materialized snapshot; use deterministic ORDER BY.",
      inputSchema: {
        targetId: z.string().min(1).max(100),
        identityToken: z.string().min(1).max(100),
        sql: z.string().min(1).max(20000),
        offset: z.number().int().min(0).max(1000000).default(0),
        shareInFlight: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      if (args.shareInFlight) {
        try {
          const status = (await desktopNetSuiteRequest(directory, {
            operation: "status",
            action: "list",
          })) as { capabilities?: string[] };
          if (!status.capabilities?.includes("query.share-in-flight"))
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    code: "UPGRADE_PENDING",
                    message:
                      "The running Desktop broker does not support in-flight read sharing. No query was submitted. Use shareInFlight:false for an independent read.",
                  }),
                },
              ],
            };
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code:
                    error instanceof DesktopNetSuiteError
                      ? error.code
                      : "NETSUITE_ERROR",
                  message:
                    "Read-sharing capability could not be checked. No query was submitted.",
                }),
              },
            ],
          };
        }
      }
      return call({ operation: "query", ...args });
    },
  );
}
