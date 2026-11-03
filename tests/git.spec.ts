import { test, expect } from "./fixtures";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { GitService } from "../server/git";
import { OfflineWorkspace } from "../server/offline";
import { LocalDatabase } from "../server/database";
import { emptyWorkspace, uid } from "../src/model";
import { gitApi } from "../server/git-api";
import { localStorageApi } from "../server/storage-api";
import { mcpDiscovery } from "../server/discovery";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GitWorkspace, GitHistory, GitCommitDetail } from "../src/git";
const execute = promisify(execFile);
test("offline MCP preserves leases, revisions and recovery while creating Git components", async ({}, info) => {
  const directory = info.outputPath("offline"),
    db = new LocalDatabase(join(directory, "workspace.sqlite")),
    owner = uid();
  db.acquire(owner);
  db.write(owner, 0, emptyWorkspace());
  db.release(owner);
  const offline = new OfflineWorkspace(directory);
  try {
    const before = offline.status();
    offline.request(
      {
        commands: [
          { operation: "app_create", args: { id: "viewer" } },
          {
            operation: "component_create",
            args: { appId: "viewer", kind: "git" },
          },
        ],
      },
      before.revision,
    );
    expect(db.read().data?.apps[0]?.blocks[0]?.kind).toBe("git");
    expect(() =>
      offline.request(
        { commands: [{ operation: "app_create", args: {} }] },
        before.revision,
      ),
    ).toThrow("changed");
    db.acquire(owner);
    expect(offline.status().editable).toBe(false);
    expect(() =>
      offline.request({ commands: [{ operation: "app_create", args: {} }] }),
    ).toThrow("browser currently owns editing");
    db.release(owner);
    offline.request({ recovery: "restore" });
    expect(db.read().data?.apps).toHaveLength(0);
  } finally {
    offline.close();
    db.close();
  }
});
async function repository(path: string, initial = "Initial canvas") {
  await mkdir(path, { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = async (...args: string[]) =>
    (
      await execute(
        "git",
        [
          "-c",
          "user.name=Orvane tests",
          "-c",
          "user.email=orvane@example.test",
          "-c",
          "commit.gpgSign=false",
          "-c",
          "tag.gpgSign=false",
          ...args,
        ],
        { cwd: path, env, windowsHide: true },
      )
    ).stdout;
  await git("init", "-b", "main");
  await writeFile(join(path, "README.md"), "Start here.\n");
  await git("add", "README.md");
  await git("commit", "-m", initial);
  await git("checkout", "-b", "feature/workspaces");
  await writeFile(join(path, "workspaces.txt"), "Projects are remembered.\n");
  await git("add", "workspaces.txt");
  await git("commit", "-m", "Remember repository workspaces");
  await git("checkout", "main");
  await writeFile(join(path, "viewer.txt"), "A visual history.\n");
  await git("add", "viewer.txt");
  await git("commit", "-m", "Add visual Git history");
  await git(
    "merge",
    "--no-ff",
    "feature/workspaces",
    "-m",
    "Merge workspace navigation",
  );
  await git("tag", "-a", "v1.0", "-m", "First viewer");
  await writeFile(join(path, "README.md"), "Start here.\nUncommitted note.\n");
  await writeFile(
    join(path, "viewer.txt"),
    "A visual history.\nStaged improvement.\n",
  );
  await git("add", "viewer.txt");
  await writeFile(join(path, "untracked.txt"), "Local draft.\n");
  return { path, git };
}

test("Git backend reads real merges, roots, refs and diffs without changing the repository", async ({}, info) => {
  const repo = await repository(info.outputPath("repository"));
  const service = new GitService(info.outputPath("data"));
  const indexBefore = await readFile(join(repo.path, ".git", "index"));
  const originalGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = join(repo.path, "not-the-selected-repository");
  try {
    const workspace = (await service.invoke("git_workspace_add", {
      path: repo.path,
    })) as GitWorkspace;
    const same = (await service.invoke("git_workspace_add", {
      path: join(repo.path, ".git", ".."),
    })) as GitWorkspace;
    expect(same.id).toBe(workspace.id);
    const history = (await service.invoke("git_history", {
      workspaceId: workspace.id,
    })) as GitHistory;
    expect(history.commits).toHaveLength(4);
    expect(history.commits[0]!.subject).toBe("Merge workspace navigation");
    expect(history.commits[0]!.parents).toHaveLength(2);
    expect(history.mainBranch).toBe("main");
    expect(history.mainline).toContain(history.head);
    expect(history.mainline).not.toContain(
      history.commits.find(
        (commit) => commit.subject === "Remember repository workspaces",
      )!.hash,
    );
    for (const order of ["date", "topo"] as const) {
      const ordered = (await service.invoke("git_history", {
        workspaceId: workspace.id,
        order,
      })) as GitHistory;
      const expected = await execute(
        "git",
        [
          "-C",
          repo.path,
          "log",
          order === "date" ? "--date-order" : "--topo-order",
          "--all",
          "--format=%H",
        ],
        {
          env: { ...process.env, GIT_DIR: join(repo.path, ".git") },
          windowsHide: true,
        },
      );
      expect(ordered.commits.map((c) => c.hash)).toEqual(
        expected.stdout.trim().split(/\r?\n/),
      );
    }
    const filtered = (await service.invoke("git_history", {
      workspaceId: workspace.id,
      ref: "refs/heads/feature/workspaces",
    })) as GitHistory;
    expect(filtered.commits.map((c) => c.subject)).toEqual([
      "Remember repository workspaces",
      "Initial canvas",
    ]);
    expect(
      history.refs.some(
        (ref) => ref.name === "v1.0" && ref.hash === history.head,
      ),
    ).toBe(true);
    const detail = (await service.invoke("git_commit", {
      workspaceId: workspace.id,
      hash: history.head,
    })) as GitCommitDetail;
    expect(detail.files).toEqual([{ path: "workspaces.txt", status: "A" }]);
    const patch = (await service.invoke("git_diff", {
      workspaceId: workspace.id,
      hash: history.head,
      file: "workspaces.txt",
    })) as { patch: string };
    expect(patch.patch).toContain("+Projects are remembered.");
    const root = history.commits.at(-1)!;
    expect(
      (
        (await service.invoke("git_commit", {
          workspaceId: workspace.id,
          hash: root.hash,
        })) as GitCommitDetail
      ).files,
    ).toEqual([{ path: "README.md", status: "A" }]);
    expect(
      (
        (await service.invoke("git_diff", {
          workspaceId: workspace.id,
          file: "README.md",
        })) as { patch: string }
      ).patch,
    ).toContain("+Uncommitted note.");
    expect(
      (
        (await service.invoke("git_diff", {
          workspaceId: workspace.id,
          file: "viewer.txt",
          mode: "index",
        })) as { patch: string }
      ).patch,
    ).toContain("+Staged improvement.");
    const firstPage = (await service.invoke("git_history", {
      workspaceId: workspace.id,
      limit: 2,
    })) as GitHistory;
    const secondPage = (await service.invoke("git_history", {
      workspaceId: workspace.id,
      limit: 2,
      offset: 2,
    })) as GitHistory;
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.hasMore).toBe(false);
    expect(
      new Set([...firstPage.commits, ...secondPage.commits].map((c) => c.hash))
        .size,
    ).toBe(4);
    expect(await readFile(join(repo.path, ".git", "index"))).toEqual(
      indexBefore,
    );
    await expect(
      service.invoke("git_diff", {
        workspaceId: workspace.id,
        hash: "--output=bad",
      }),
    ).rejects.toThrow();
    service.close();
    expect(
      ((await service.invoke("git_workspace_list", {})) as GitWorkspace[])[0]!
        .id,
    ).toBe(workspace.id);
  } finally {
    service.close();
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
  }
});

test("unborn Git repositories show empty history and accept canonical subfolder registration", async ({}, info) => {
  const root = info.outputPath("empty-repository");
  await mkdir(join(root, "nested"), { recursive: true });
  await execute("git", ["init", "-b", "main"], {
    cwd: root,
    windowsHide: true,
  });
  const service = new GitService(info.outputPath("empty-data"));
  try {
    const workspace = (await service.invoke("git_workspace_add", {
      path: join(root, "nested"),
    })) as GitWorkspace;
    const history = (await service.invoke("git_history", {
      workspaceId: workspace.id,
    })) as GitHistory;
    expect(history.commits).toEqual([]);
    expect(history.head).toBe("");
    expect(
      (
        (await service.invoke("git_status", { workspaceId: workspace.id })) as {
          files: unknown[];
        }
      ).files,
    ).toEqual([]);
  } finally {
    service.close();
  }
});

test("opening a commit with very long lines keeps the viewer width; the patch scrolls", async ({
  page,
}, info) => {
  const repo = await repository(info.outputPath("Long lines"));
  await writeFile(join(repo.path, "plan.md"), `${"wide ".repeat(600)}\n`);
  await repo.git("add", "plan.md");
  await repo.git("commit", "-m", "Add a very wide plan");
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Create Git viewer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose a folder", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Local folder path" })
    .fill(repo.path);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  const viewer = page.locator(".git-viewer");
  const widths = () =>
    viewer.evaluate((root) => ({
      viewer: root.scrollWidth,
      box: root.clientWidth,
      history: root.querySelector(".git-history-rows")!.scrollWidth,
      historyBox: root.querySelector(".git-history-rows")!.clientWidth,
    }));
  await expect(page.locator(".git-commit-row")).toHaveCount(5);
  await page
    .locator(".git-commit-row")
    .filter({ hasText: "Add a very wide plan" })
    .click();
  await expect(page.getByLabel("Git diff", { exact: true })).toContainText(
    "+wide wide",
  );
  const after = await widths();
  expect(after.viewer).toBeLessThanOrEqual(after.box + 1);
  expect(after.history).toBeLessThanOrEqual(after.historyBox + 1);
  const patch = page.getByLabel("Git diff", { exact: true });
  expect(
    await patch.evaluate((el) => el.scrollWidth > el.clientWidth + 100),
  ).toBe(true);
});
test("commit search finds older commits across the whole history and lists only matches", async ({
  page,
}, info) => {
  const repo = await repository(info.outputPath("Search"));
  await repo.git("commit", "--allow-empty", "-m", "Needle in an old haystack");
  // More commits than the first page (150) on top, written in one go.
  const branch = (await repo.git("symbolic-ref", "--short", "HEAD")).trim();
  let stream = "";
  for (let i = 0; i < 170; i++) {
    const message = `Filler change ${i}\n`;
    stream +=
      `commit refs/heads/${branch}\ncommitter Orvane tests <orvane@example.test> ${1700000000 + i} +0000\n` +
      `data ${Buffer.byteLength(message)}\n${message}` +
      (i === 0 ? `from refs/heads/${branch}^0\n` : "") +
      "\n";
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo.path, input: stream, windowsHide: true });
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Create Git viewer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose a folder", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Local folder path" })
    .fill(repo.path);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  const rows = page.locator(".git-commit-row");
  await expect(rows).toHaveCount(150);
  await expect(rows.filter({ hasText: "haystack" })).toHaveCount(0);
  // Contains, case-insensitive, beyond the loaded page; only matches shown.
  const search = page.getByRole("textbox", { name: "Search commits" });
  await search.fill("HAYSTACK");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Needle in an old haystack");
  await expect(page.getByRole("button", { name: "1 matches" })).toBeVisible();
  await search.fill("change 16");
  await expect(rows).toHaveCount(11);
  await search.fill("no such commit");
  await expect(rows).toHaveCount(0);
  await expect(page.locator(".git-viewer")).toContainText("No commit matches");
  await search.fill("");
  await expect(rows).toHaveCount(150);
});
test("folder picker saves a local Git workspace and preserves selection across reloads", async ({
  page,
}, info) => {
  const repo = await repository(info.outputPath("Pick this repository"));
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Create Git viewer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose a folder", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Local folder path" })
    .fill(repo.path);
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Git workspace name" })
    .fill("My local project");
  await page
    .getByRole("button", { name: "Use this folder", exact: true })
    .click();
  await expect(page.locator(".git-commit-row")).toHaveCount(4);
  await expect(
    page.getByRole("combobox", { name: "Git workspace", exact: true }),
  ).toHaveText("My local project");
  await page.getByRole("button", { name: /Changes/ }).click();
  await expect(page.locator(".git-change-row")).toHaveCount(3);
  await page
    .locator(".git-change-row")
    .filter({ hasText: "README.md" })
    .click();
  await expect(page.getByLabel("Git diff", { exact: true })).toContainText(
    "+Uncommitted note.",
  );
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Git workspace", exact: true }),
  ).toHaveText("My local project");
  await expect(page.locator(".git-commit-row")).toHaveCount(4);
});

test("real MCP tools register repositories and create a live Git viewer with workspace switching", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const repo = await repository(info.outputPath("repository"));
  const other = await repository(
    info.outputPath("other-repository"),
    "Second project seed",
  );
  const directory = info.outputPath("data");
  const vite = await createServer({
    configFile: false,
    cacheDir: info.outputPath("vite-cache"),
    root: resolve("."),
    plugins: [
      vue(),
      gitApi(directory),
      localStorageApi(directory),
      mcpDiscovery(directory),
    ],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("No local port.");
    const origin = `http://127.0.0.1:${address.port}`;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("server/launch.mjs")],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ORVANE_MCP_STATE_DIR: directory,
        ORVANE_DATA_DIR: directory,
        ORVANE_MCP_PORT: "0",
        ORVANE_MCP_ORIGINS: origin,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "git-viewer-test", version: "1.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("git_workspace_add");
    expect(tools.tools.map((t) => t.name)).toContain("git_history");
    async function call(name: string, args: Record<string, unknown> = {}) {
      const result = await client!.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result.content));
      return (result.structuredContent as { result: any }).result;
    }
    const workspace = (await call("git_workspace_add", {
      path: repo.path,
      name: "Canvas development",
    })) as GitWorkspace;
    await page.addInitScript(() =>
      localStorage.setItem("orvane.examples.v1", "installed"),
    );
    await page.goto(origin);
    await expect
      .poll(async () => (await call("workspace_status")).connected, {
        timeout: 15000,
      })
      .toBe(true);
    await call("workspace_batch", {
      commands: [
        {
          operation: "app_create",
          args: {
            id: "git-app",
            properties: {
              name: "Git viewer",
              icon: "git",
              x: 140,
              y: 80,
              width: 1160,
              height: 760,
              padding: 0,
              gap: 0,
            },
          },
        },
        {
          operation: "component_create",
          args: {
            appId: "git-app",
            id: "git-component",
            kind: "git",
            properties: {
              label: "Local Git",
              sizing: "fill",
              gitWorkspaceId: workspace.id,
            },
          },
        },
      ],
    });
    await call("app_focus", { appId: "git-app" });
    await expect(page.locator(".canvas-plane")).not.toHaveClass(
      /camera-moving/,
    );
    await expect(page.locator(".git-commit-row")).toHaveCount(4);
    await expect(page.locator(".git-main-legend")).toContainText(
      "main · main branch",
    );
    await expect(page.locator(".git-ref.ref-main")).toHaveText("main");
    await expect(
      page.locator(".git-commit-row.main-branch-commit"),
    ).toHaveCount(3);
    await expect(
      page.locator(".git-ref").filter({ hasText: "feature/workspaces" }),
    ).toBeVisible();
    await call("app_update", { appId: "git-app", patch: { width: 580 } });
    expect((await call("app_get", { appId: "git-app" })).results[0].width).toBe(
      720,
    );
    await call("app_update", {
      appId: "git-app",
      patch: { minWidth: 760, minHeight: 480, width: 180, height: 160 },
    });
    const constrained = (await call("app_get", { appId: "git-app" }))
      .results[0];
    expect(constrained.width).toBe(760);
    expect(constrained.height).toBe(480);
    const edge = page.locator(".edge-e").first();
    const edgeBox = (await edge.boundingBox())!;
    await page.mouse.move(
      edgeBox.x + edgeBox.width / 2,
      edgeBox.y + edgeBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(edgeBox.x - 150, edgeBox.y + edgeBox.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    expect((await call("app_get", { appId: "git-app" })).results[0].width).toBe(
      760,
    );
    const firstRow = page.locator(".git-commit-row").first();
    await expect
      .poll(() =>
        firstRow.evaluate((row) => {
          const bounds = row.getBoundingClientRect();
          return [...row.children].every(
            (child) => child.getBoundingClientRect().right <= bounds.right + 1,
          );
        }),
      )
      .toBe(true);
    expect(
      await page
        .locator(".git-history")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await firstRow.hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "Merge workspace navigation",
    );
    const tipBox = (await page.getByRole("tooltip").boundingBox())!;
    const rowBounds = (await firstRow.boundingBox())!;
    expect(tipBox.x - (rowBounds.x + rowBounds.width / 2)).toBeCloseTo(16, 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const delta of [200, -400, 200]) {
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, delta);
      await page.keyboard.up("Control");
      const bounds = (await firstRow.boundingBox())!;
      const x = bounds.x + 140,
        y = bounds.y + bounds.height / 2;
      await page.mouse.move(x, y);
      await expect(page.getByRole("tooltip")).toBeVisible();
      await expect
        .poll(
          async () => (await page.getByRole("tooltip").boundingBox())!.x - x,
        )
        .toBeCloseTo(16, 0);
      await page.mouse.move(x + 28, y);
      await expect
        .poll(
          async () =>
            (await page.getByRole("tooltip").boundingBox())!.x - (x + 28),
        )
        .toBeCloseTo(16, 0);
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(firstRow.locator("[title]")).toHaveCount(0);
    await page.screenshot({ path: "artifacts/git-viewer-compact.png" });
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await call("app_update", {
      appId: "git-app",
      patch: { width: 1160, height: 760, y: -160 },
    });
    await page.screenshot({ path: "artifacts/git-frost-header.png" });
    await call("app_update", { appId: "git-app", patch: { y: 80 } });
    await page
      .locator(".git-commit-row")
      .filter({ hasText: "Merge workspace navigation" })
      .click();
    await expect(page.getByLabel("Git diff", { exact: true })).toContainText(
      "+Projects are remembered.",
    );
    await page.screenshot({ path: "artifacts/git-viewer.png" });
    const resizer = page.getByRole("separator", { name: "Resize Git details" });
    const detailPane = page.getByRole("region", { name: "Git details" });
    const initialHeight = (await detailPane.boundingBox())!.height;
    const handleBounds = (await resizer.boundingBox())!;
    await page.mouse.move(
      handleBounds.x + handleBounds.width / 2,
      handleBounds.y + handleBounds.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handleBounds.x + handleBounds.width / 2,
      handleBounds.y - 90,
      { steps: 5 },
    );
    await page.mouse.up();
    expect((await detailPane.boundingBox())!.height).toBeGreaterThan(
      initialHeight + 60,
    );
    await resizer.focus();
    const beforeKey = Number(await resizer.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowUp");
    expect(Number(await resizer.getAttribute("aria-valuenow"))).toBeGreaterThan(
      beforeKey,
    );
    const transform = await page.locator(".canvas-plane").getAttribute("style");
    const pixelRatio = await page.evaluate(() => window.devicePixelRatio);
    await page.getByLabel("Git diff", { exact: true }).hover();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 130);
    await page.keyboard.up("Control");
    await expect
      .poll(() => page.locator(".canvas-plane").getAttribute("style"))
      .not.toBe(transform);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(pixelRatio);
    await page
      .getByRole("combobox", { name: "Git history order", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Branch topology", exact: true })
      .click();
    await expect(page.locator(".git-commit-row")).toHaveCount(4);
    const second = (await call("git_workspace_add", {
      path: other.path,
      name: "Another project",
    })) as GitWorkspace;
    await page.getByRole("button", { name: "Refresh Git history" }).click();
    await page
      .getByRole("combobox", { name: "Git workspace", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Another project", exact: true })
      .click();
    await expect(
      page
        .locator(".git-commit-row")
        .filter({ hasText: "Second project seed" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Git workspace", exact: true }),
    ).toHaveText("Another project");
    expect(
      (await call("git_history", { workspaceId: second.id })).commits,
    ).toHaveLength(4);
    const blocked = await fetch(`${origin}/__orvane/git/git_workspace_list`, {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(blocked.status).toBe(403);
  } finally {
    await client?.close();
    await transport?.close();
    await vite.close();
  }
});
