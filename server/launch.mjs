// Absolute entrypoint for MCP clients: independent of their working directory.
import { tsImport } from "tsx/esm/api";
await tsImport("./index.ts", import.meta.url);
