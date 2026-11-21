import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  pickEnvironment,
  registerBrowserAgentHost,
  runBrowserAgent,
  type AgentAccess,
  type AgentTabInfo,
  type NetSuiteEnvironment,
} from "../src/browserAgent";

const environments: NetSuiteEnvironment[] = [
  { origin: "https://1234567.app.netsuite.com", label: "Consitech Srl (1234567)", accountId: "1234567", name: "Consitech Srl", type: "Production" },
  { origin: "https://1234567-sb1.app.netsuite.com", label: "Consitech Srl - Sandbox (1234567_SB1)", accountId: "1234567_SB1", name: "Consitech Srl - Sandbox", type: "Sandbox" },
  { origin: "https://7654321-sb1.app.netsuite.com", label: "Other Co - Sandbox (7654321_SB1)", accountId: "7654321_SB1", name: "Other Co - Sandbox", type: "Sandbox" },
];

test("pickEnvironment finds an environment by words, account ID or address", () => {
  expect(pickEnvironment(environments, "sandbox consitech").origin).toBe("https://1234567-sb1.app.netsuite.com");
  expect(pickEnvironment(environments, "Consitech production").origin).toBe("https://1234567.app.netsuite.com");
  expect(pickEnvironment(environments, "1234567-sb1").origin).toBe("https://1234567-sb1.app.netsuite.com");
  expect(pickEnvironment(environments, "1234567_sb1").origin).toBe("https://1234567-sb1.app.netsuite.com");
  expect(pickEnvironment(environments, "https://7654321-sb1.app.netsuite.com").label).toContain("Other Co");
  expect(() => pickEnvironment(environments, "sandbox")).toThrow(/matches 2 environments/);
  expect(() => pickEnvironment(environments, "acme")).toThrow(/No NetSuite environment matches "acme"/);
  expect(() => pickEnvironment(environments, " ")).toThrow(/Name the environment/);
});

test("netsuite ops read through a shared NetSuite tab and open like the header picker", async () => {
  const tabs: AgentTabInfo[] = [
    { tabId: "docs", title: "Docs", url: "https://example.com/", active: false },
    { tabId: "prod", title: "NetSuite", url: "https://1234567.app.netsuite.com/app/center/card.nl", active: true },
  ];
  const access: Record<string, AgentAccess | undefined> = {};
  const looked: string[] = [];
  let next = 0;
  const stop = registerBrowserAgentHost({
    blockId: "block-ns",
    tabs: () => tabs.map((t) => ({ ...t, ...(access[t.tabId] ? { access: access[t.tabId] } : {}) })),
    open: () => "unused",
    access: (id) => access[id],
    setAccess: (id, value) => void (access[id] = value),
    page: () => undefined,
    navigate: () => undefined,
    select: () => undefined,
    close: () => undefined,
    async netSuiteEnvironments(tabId) {
      looked.push(tabId);
      return environments;
    },
    openNetSuiteEnvironment(origin) {
      const existing = tabs.find((t) => new URL(t.url).origin === origin);
      if (existing) return existing.tabId;
      const tabId = `new-${++next}`;
      tabs.push({ tabId, title: "", url: `${origin}/app/center/card.nl`, active: true });
      return tabId;
    },
  });
  const context = { browserBlocks: () => [], mount: () => undefined };
  const run = (op: "netsuite-environments" | "netsuite-open", args: Record<string, unknown> = {}) =>
    runBrowserAgent({ kind: "browser", op, args }, context) as Promise<Record<string, unknown>>;
  try {
    // Nothing shared yet: the AI is told how to get a tab.
    await expect(run("netsuite-environments")).rejects.toThrow(/No signed-in NetSuite tab is shared/);
    await expect(run("netsuite-environments", { tabId: "prod" })).rejects.toThrow(/has not shared tab prod/);

    // Once the user shares the NetSuite tab, the list comes through it.
    access.prod = "granted";
    const listed = await run("netsuite-environments");
    expect(listed).toMatchObject({ source: "prod", current: "https://1234567.app.netsuite.com" });
    expect((listed.environments as NetSuiteEnvironment[]).map((e) => e.accountId)).toEqual(["1234567", "1234567_SB1", "7654321_SB1"]);
    expect(looked).toEqual(["prod"]);

    // A shared tab that is not NetSuite is refused as the source.
    access.docs = "granted";
    await expect(run("netsuite-environments", { tabId: "docs" })).rejects.toThrow(/not a signed-in NetSuite page/);

    // Open a new environment: a new tab for the user, shared (granted) with the AI.
    const opened = await run("netsuite-open", { environment: "sandbox consitech" });
    expect(opened).toMatchObject({ tabId: "new-1", reused: false, access: "granted", environment: { accountId: "1234567_SB1" } });

    // Open an account already in a tab: that tab is reused and its access is left alone.
    access.prod = undefined;
    access.docs = undefined;
    access["new-1"] = "granted";
    const again = await run("netsuite-open", { environment: "consitech production" });
    expect(again).toMatchObject({ tabId: "prod", reused: true, access: "none" });

    // An unclear name returns the candidates.
    await expect(run("netsuite-open", { environment: "sandbox" })).rejects.toThrow(/matches 2 environments/);
  } finally {
    stop();
  }
});

test("browser_netsuite_environments is offered over MCP and needs the open Orvane window", async () => {
  test.setTimeout(60_000);
  const directory = await mkdtemp(join(tmpdir(), "orvane-ns-env-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server/launch.mjs")],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      ORVANE_MCP_STATE_DIR: directory,
      ORVANE_DATA_DIR: directory,
      ORVANE_MCP_PORT: "0",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "orvane-ns-env-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "browser_netsuite_environments");
    expect(tool?.description).toContain("sandbox consitech");
    const result = (await client.callTool({ name: "browser_netsuite_environments", arguments: { action: "list" } })) as {
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
  } finally {
    await client.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});
