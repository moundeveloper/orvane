import { test, expect } from "./fixtures";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("one Orvane connector exposes NetSuite and session-bound exposition tools", async ({}, info) => {
  const dir = info.outputPath("mcp"),
    root = join(dir, "projects"),
    folder = join(root, "fixture");
  await mkdir(folder, { recursive: true });
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectPath = process.cwd();
  await writeFile(
    join(folder, sessionId + ".jsonl"),
    JSON.stringify({
      uuid: "prompt",
      sessionId,
      cwd: projectPath,
      type: "user",
      message: { content: "Explain an architecture" },
    }) + "\n",
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "server/launch.mjs")],
      env: {
        ...env,
        ORVANE_MCP_PROFILE: "desktop",
        ORVANE_DATA_DIR: dir,
        ORVANE_CLAUDE_PROJECTS_DIR: root,
      },
      stderr: "pipe",
    }),
    client = new Client({ name: "orvane-test", version: "1" });
  try {
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("orvane");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "exposition_read",
      "exposition_sessions",
      "exposition_show",
      "exposition_update",
      "orvane_netsuite_artifact",
      "orvane_netsuite_query",
      "orvane_netsuite_read",
      "orvane_netsuite_status",
    ]);
    const target = { sessionId, projectPath },
      view = {
        id: "architecture",
        title: "Run ownership",
        status: "proposal",
        parts: [
          {
            id: "flow",
            type: "flow",
            title: "UI calls the engine",
            nodes: [
              { id: "ui", title: "Admin UI", lines: ["Requests a run"] },
              {
                id: "engine",
                title: "Server engine",
                lines: ["Owns execution"],
              },
            ],
            edges: [{ from: "ui", to: "engine", label: "Start" }],
          },
        ],
      };
    const first = await client.callTool({
      name: "exposition_show",
      arguments: { ...target, view },
    });
    expect(first.isError).not.toBe(true);
    expect(
      JSON.parse((first.content as { text: string }[])[0]!.text).revision,
    ).toBe(1);
    expect(
      (
        await client.callTool({
          name: "exposition_show",
          arguments: { ...target, projectPath: "C:/Wrong", view },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await client.callTool({
          name: "exposition_update",
          arguments: {
            ...target,
            id: view.id,
            expectedRevision: 1,
            summary: "Updated",
          },
        })
      ).isError,
    ).not.toBe(true);
    const read = await client.callTool({
      name: "exposition_read",
      arguments: target,
    });
    expect(
      JSON.parse((read.content as { text: string }[])[0]!.text).visuals[0]
        .revision,
    ).toBe(2);
  } finally {
    await client.close();
  }
});
