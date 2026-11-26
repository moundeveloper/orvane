import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { ClaudeProfiles, within } from "../server/claude-profiles.ts";
import { AgentRunner } from "../server/agent-runner.ts";
import { sameAgentSession } from "../src/agentSessions.ts";

async function fixture(run: (profiles: ClaudeProfiles, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "orvane-profile-registry-"));
  const inherited = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "default");
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const profiles = new ClaudeProfiles(join(root, "data", "workspace.sqlite"), {
    home: join(root, "generated"),
    forbidden: [join(root, "data")],
  });
  try {
    await run(profiles, root);
  } finally {
    profiles.close();
    if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = inherited;
    const rel = relative(tmpdir(), root);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
    await rm(root, { recursive: true, force: true });
  }
}

test("folder containment includes descendants whose names start with two dots", () => {
  const root = join(tmpdir(), "account");
  assert.equal(within(join(root, "..private"), root), true);
  assert.equal(within(join(root, "..", "another-account"), root), false);
});

test("session identity includes provider, account and an exact known transcript key", () => {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const work = { provider: "claude" as const, profileId: "work-one", sessionId, key: "claude@work-one:source" };
  assert.equal(sameAgentSession(work, { ...work }), true);
  assert.equal(sameAgentSession(work, { ...work, profileId: "default" }), false);
  assert.equal(sameAgentSession(work, { ...work, provider: "codex" }), false);
  assert.equal(sameAgentSession(work, { ...work, key: "claude@work-one:copy" }), false);
  assert.equal(sameAgentSession(work, { provider: "claude", profileId: "work-one", sessionId }), true);
  assert.equal(sameAgentSession({}, {}), false);
});

test("concurrent account additions retain both registrations", async () => {
  await fixture(async (profiles) => {
    const added = await Promise.all([
      profiles.add({ id: "work-one", name: "Work one" }),
      profiles.add({ id: "work-two", name: "Work two" }),
    ]);
    const ids = new Set(profiles.list().map((profile) => profile.id));
    for (const profile of added) assert.ok(ids.has(profile.id), `Lost registration ${profile.id}`);
    assert.equal(ids.size, 3);
  });
});

test("concurrent registrations cannot claim one physical folder twice", async () => {
  await fixture(async (profiles, root) => {
    const folder = join(root, "existing-account");
    await mkdir(folder);
    const results = await Promise.allSettled([
      profiles.add({ id: "work-one", name: "Work one", folder }),
      profiles.add({ id: "work-two", name: "Work two", folder }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(profiles.list().length, 2);
  });
});

test("concurrent registrations cannot duplicate an account name", async () => {
  await fixture(async (profiles) => {
    const results = await Promise.allSettled([
      profiles.add({ id: "work-one", name: "Work" }),
      profiles.add({ id: "work-two", name: "work" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(profiles.list().length, 2);
  });
});

test("Default preserves set versus unset configuration and resolved account environments are frozen copies", async () => {
  await fixture(async (profiles, root) => {
    const inherited = process.env.CLAUDE_CONFIG_DIR;
    const withOverride = profiles.resolve("default");
    assert.equal(withOverride.env.CLAUDE_CONFIG_DIR, inherited);
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      const withoutOverride = profiles.resolve("default");
      assert.equal(withoutOverride.env.CLAUDE_CONFIG_DIR, undefined);
      const added = await profiles.add({ id: "work-one", name: "Work" });
      const work = profiles.resolve(added.id);
      assert.equal(work.env.CLAUDE_CONFIG_DIR, added.configDir);
      process.env.CLAUDE_CONFIG_DIR = join(root, "later");
      assert.equal(work.env.CLAUDE_CONFIG_DIR, added.configDir);
      assert.equal(withOverride.env.CLAUDE_CONFIG_DIR, inherited);
      assert.ok(Object.isFrozen(work.env));
    } finally {
      if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = inherited;
    }
  });
});

test("removing a profile while project validation awaits prevents its run from registering", async () => {
  await fixture(async (profiles, root) => {
    const added = await profiles.add({ id: "work-one", name: "Work" });
    const runner = new AgentRunner(join(root, "runs"), () => {}, () => {
      throw Error("UNEXPECTED_CLI_LOOKUP");
    });
    runner.validateProfile = (id: string) => { profiles.resolve(id); };
    try {
      const started = runner.start({ provider: "claude", profile: profiles.resolve(added.id), folder: root }, "Run");
      profiles.remove(added.id, { running: 0, signingIn: false, schedules: [] });
      await assert.rejects(started, /removed/);
      assert.equal(runner.recent().length, 0);
    } finally {
      runner.close();
    }
  });
});

test("approval and checkpoint history exclude other accounts and providers sharing a UUID", async () => {
  await fixture(async (profiles, root) => {
    const work = await profiles.add({ id: "work-one", name: "Work" });
    const directory = join(root, "history");
    const logs = join(directory, "agent-runs");
    await mkdir(logs, { recursive: true });
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const identities = [
      { provider: "claude", profileId: "default", name: "Default" },
      { provider: "claude", profileId: work.id, name: "Work" },
      { provider: "codex", name: "Codex" },
    ];
    for (const identity of identities) await writeFile(join(logs, `${identity.name}.json`), JSON.stringify({
      ...identity, id: identity.name, sessionId, message: identity.name, folder: root,
      checkpoint: { commit: identity.name, at: new Date().toISOString() },
      decisions: [{ tool: identity.name, allowed: true, at: new Date().toISOString() }],
    }));
    const runner = new AgentRunner(directory, () => {});
    try {
      assert.deepEqual((await runner.approvals(sessionId, work.id, "claude")).map((entry) => entry.tool), ["Work"]);
      assert.deepEqual((await runner.sessionCheckpoints(sessionId, work.id, "claude")).map((entry) => entry.message), ["Work"]);
      assert.deepEqual((await runner.sessionCheckpoints(sessionId, undefined, "codex")).map((entry) => entry.message), ["Codex"]);
    } finally {
      runner.close();
    }
  });
});
