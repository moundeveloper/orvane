import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { netsuiteInstructions, registerNetSuiteTools } from "./netsuite-tools.ts";

const profile = process.env.ORVANE_MCP_PROFILE;
const directory =
  process.env.ORVANE_DATA_DIR ||
  fileURLToPath(new URL("../.orvane", import.meta.url));
const exposition =
  profile !== "netsuite" ? await import("./exposition-tools.ts") : undefined;
const server = new McpServer(
  {
    name: profile === "desktop" ? "orvane" : `orvane-${profile}`,
    version: "0.1.0",
  },
  {
    instructions: [
      profile !== "exposition" ? netsuiteInstructions : undefined,
      exposition?.expositionInstructions,
    ]
      .filter(Boolean)
      .join("\n\n"),
  },
);
if (profile !== "exposition") registerNetSuiteTools(server, directory);
const transport = new StdioServerTransport();
transport.onclose = exposition?.registerExpositionTools(server, directory);
process.stdin.once("end", () => {
  void server.close();
});
await server.connect(transport);
console.error(`Orvane MCP ready (${profile} profile).`);
