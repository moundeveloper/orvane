import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

// The design method reaches every connected AI: a short pointer in the server
// instructions (which clients cut off around 4,000 characters), the
// design_guide tool and /design prompt, and the method attached once to the
// first UI Maker tool that starts design work.
test("Orvane MCP serves the design method and attaches it to design work once", async ({}, info) => {
  test.setTimeout(90_000);
  const data = info.outputPath("data");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ORVANE_DATA_DIR: data,
    ORVANE_MCP_STATE_DIR: data,
    ORVANE_MCP_PORT: "0",
  };
  const client = new Client({ name: "design-guide-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("server/launch.mjs")], env, stderr: "pipe" }));
  try {
    const instructions = client.getInstructions() ?? "";
    expect(instructions.length).toBeLessThan(3_800);
    for (const part of ["call design_guide", "UI Maker Lab", "NetSuite status", "Exposition (exposition_*)", "Browser control (browser_*)"])
      expect(instructions).toContain(part);

    const { tools } = await client.listTools();
    const describe = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
    expect(describe("design_guide")).toContain("design method");
    // Details moved out of the instructions stay with their tools.
    expect(describe("uimaker_brief")).toContain("red marks mean wrong or remove");
    expect(describe("uimaker_lab_round")).toContain("no headings, descriptions, captions");
    expect(describe("exposition_show")).toContain("Compose typed parts");
    expect(describe("component_create")).toContain("orvane.list({container,count,rowHeight,render})");
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain("design");

    const texts = (result: Awaited<ReturnType<typeof client.callTool>>) =>
      (result.content as { type: string; text?: string }[]).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    // First design step in this connection carries the method; later ones do not.
    const created = await client.callTool({ name: "uimaker_create", arguments: { name: "Design check" } });
    expect(created.isError).toBeFalsy();
    expect(texts(created)).toContain("# Orvane design method");
    expect(texts(created)).toContain("composer-glass:");
    const id = JSON.parse((created.content as { text: string }[])[0]!.text).id as string;
    const round = await client.callTool({ name: "uimaker_lab_round", arguments: { component: id, title: "Layouts", kind: "new" } });
    expect(round.isError).toBeFalsy();
    expect(texts(round)).not.toContain("# Orvane design method");

    const example = await client.callTool({ name: "design_guide", arguments: { example: "run-changes" } });
    const items = example.content as { type: string; text?: string; mimeType?: string }[];
    expect(items[0]!.text).toContain("Files changed card");
    expect(items[0]!.text).toContain("<!doctype html>");
    expect(items[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    const look = await client.callTool({ name: "design_guide", arguments: { topic: "look", show: ["drawn-tick", "dna-loader"] } });
    expect(texts(look)).toContain("--canvas:#e9edf0");
    expect((look.content as { type: string }[]).filter((item) => item.type === "image")).toHaveLength(2);
    const unknown = await client.callTool({ name: "design_guide", arguments: { example: "nope" } });
    expect(unknown.isError).toBe(true);
    expect(texts(unknown)).toContain("Available: composer-glass");
  } finally {
    await client.close();
  }
});
