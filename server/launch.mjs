// Absolute entrypoint for MCP clients: independent of their working directory.
import { tsImport } from "tsx/esm/api";
await tsImport(process.env.ORVANE_MCP_PROFILE === "netsuite" ? "./netsuite-mcp.ts" : "./index.ts", import.meta.url);
