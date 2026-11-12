import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Only enumerate status. Never choose an account, inspect records, or run SQL.
const client = new Client({ name: "orvane-batch-one-check", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../server/launch.mjs", import.meta.url))],
  env: {
    ...process.env,
    ORVANE_MCP_PROFILE: "netsuite",
    ORVANE_DATA_DIR:
      process.env.ORVANE_DATA_DIR ||
      fileURLToPath(new URL("../.orvane", import.meta.url)),
  },
  stderr: "pipe",
});
transport.stderr?.resume();
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log("Tools:", tools.tools.map((tool) => tool.name).join(", "));
  const result = await client.callTool({
    name: "orvane_netsuite_status",
    arguments: { action: "list" },
  });
  if (result.isError) throw Error(JSON.stringify(result.content));
  console.log(JSON.stringify(result.structuredContent?.result, null, 2));
} finally {
  await client.close();
  await transport.close();
}
