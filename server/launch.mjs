// Absolute entrypoint for MCP clients: independent of their working directory.
import { tsImport } from "tsx/esm/api";
const connectorProfiles = ["desktop", "exposition", "netsuite"];
await tsImport(
  connectorProfiles.includes(process.env.ORVANE_MCP_PROFILE)
    ? "./connector-mcp.ts"
    : "./index.ts",
  import.meta.url,
);
