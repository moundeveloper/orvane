import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { Readable } from "node:stream";
import { LocalDatabase } from "./database.ts";
import { GitService } from "./git.ts";
export function createProjectsService(
  directory: string,
  filename = "workspace.sqlite",
) {
  const database = new LocalDatabase(path.join(directory, filename));
  const spawnTool = (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => {
    if (process.platform !== "win32")
      return spawn(command, args, {
        ...options,
        windowsHide: true,
        timeout: 300000,
      });
    const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    const script = `$ErrorActionPreference='Stop'; & ${literal(command)} ${args.map(literal).join(" ")}; exit $LASTEXITCODE`;
    return spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { ...options, windowsHide: true, timeout: 300000 },
    );
  };
  type ApiRequest = {
    rootPath?: string;
    name?: string;
    groupId?: string;
    path?: string;
    paths?: string[];
    groupIds?: string[];
    workspacePath?: string;
    deleteFolder?: boolean;
    template?: string;
    command?: string;
    account?: string;
    terminalState?: TerminalState;
  };
  type HubGroup = {
    id: string;
    name: string;
    workspacePath?: string;
    projectPaths: string[];
  };
  type TerminalState = {
    isOpen?: boolean;
    isMaximized?: boolean;
    height?: number;
    activeCwd?: string;
    tabs?: { title: string; cwd: string }[];
  };
  type HubData = {
    groups: HubGroup[];
    ignoredProjectPaths: string[];
    terminalState?: TerminalState;
  };

  const metadataFileName = ".projects-hub.json";

  const readJsonBody = async (
    req: import("node:http").IncomingMessage,
  ): Promise<ApiRequest> => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString("utf8");
    return body ? JSON.parse(body) : {};
  };

  const sendJson = (
    res: import("node:http").ServerResponse,
    status: number,
    data: unknown,
  ) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
  };

  const sanitizeFolderName = (name: string) => {
    const cleaned = name
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ");

    if (!cleaned || cleaned === "." || cleaned === "..") {
      throw new Error("Enter a valid folder name.");
    }

    return cleaned;
  };

  const sanitizePathSegment = sanitizeFolderName;

  const sanitizePackageName = (name: string) => {
    const cleaned = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (!cleaned || cleaned === "." || cleaned === "..") {
      throw new Error("Enter a valid project name.");
    }

    return cleaned;
  };

  const getGitCloneFolderName = (repository: string) => {
    const normalized = repository
      .trim()
      .replace(/[?#].*$/, "")
      .replace(/[\\/]+$/, "");
    const folderName =
      normalized
        .split(/[\\/:]/)
        .pop()
        ?.replace(/\.git$/i, "") ?? "";
    return sanitizeFolderName(folderName);
  };

  const createId = () =>
    `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const metadataPath = (rootPath: string) =>
    path.join(path.resolve(rootPath), metadataFileName);

  const getDefaultGroupWorkspacePath = (rootPath: string, groupName: string) =>
    path.join(path.resolve(rootPath), sanitizePathSegment(groupName));

  const normalizeWorkspacePath = (
    rootPath: string,
    groupName: string,
    workspacePath?: string,
  ) =>
    path.resolve(
      workspacePath?.trim() ||
        getDefaultGroupWorkspacePath(rootPath, groupName),
    );

  const normalizeTerminalState = (
    state: unknown,
  ): TerminalState | undefined => {
    if (!state || typeof state !== "object") return undefined;

    const value = state as TerminalState;
    return {
      isOpen: typeof value.isOpen === "boolean" ? value.isOpen : undefined,
      isMaximized:
        typeof value.isMaximized === "boolean" ? value.isMaximized : undefined,
      height: typeof value.height === "number" ? value.height : undefined,
      activeCwd:
        typeof value.activeCwd === "string"
          ? path.resolve(value.activeCwd)
          : undefined,
      tabs: Array.isArray(value.tabs)
        ? value.tabs
            .filter(
              (tab) => tab && typeof tab.cwd === "string" && tab.cwd.trim(),
            )
            .map((tab) => {
              const cwd = path.resolve(tab.cwd);
              return {
                cwd,
                title:
                  typeof tab.title === "string" && tab.title.trim()
                    ? tab.title
                    : path.basename(cwd),
              };
            })
        : undefined,
    };
  };

  const readHubData = async (rootPath: string): Promise<HubData> => {
    try {
      const saved = database.appData(
        "projects:" + path.resolve(rootPath).toLowerCase(),
      );
      const raw = saved
        ? JSON.stringify(saved)
        : await readFile(metadataPath(rootPath), "utf8");
      const parsed = JSON.parse(raw) as HubData;

      return {
        groups: Array.isArray(parsed.groups)
          ? parsed.groups.map((group) => ({
              id: group.id || createId(),
              name: group.name,
              workspacePath:
                typeof group.workspacePath === "string" &&
                group.workspacePath.trim()
                  ? path.resolve(group.workspacePath)
                  : undefined,
              projectPaths: Array.isArray(group.projectPaths)
                ? group.projectPaths.map((p) => path.resolve(p))
                : [],
            }))
          : [],
        ignoredProjectPaths: Array.isArray(parsed.ignoredProjectPaths)
          ? parsed.ignoredProjectPaths.map((p) => path.resolve(p))
          : [],
        terminalState: normalizeTerminalState(parsed.terminalState),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { groups: [], ignoredProjectPaths: [] };
    }
  };

  const writeHubData = async (rootPath: string, data: HubData) => {
    database.saveAppData(
      "projects:" + path.resolve(rootPath).toLowerCase(),
      data,
    );
  };

  const getProjects = async (
    rootPath: string,
    excludedPaths: Set<string> = new Set(),
  ) => {
    const root = path.resolve(rootPath);
    const projects = [];

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;

      const projectPath = path.join(root, entry.name);
      if (excludedPaths.has(projectPath)) continue;
      const info = await stat(projectPath);

      projects.push({
        name: entry.name,
        path: projectPath,
        modifiedAt: info.mtime.toISOString(),
      });
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  };

  const getDirectoryPaths = async (parentPath: string) => {
    const entries = await readdir(parentPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parentPath, entry.name));
  };

  const getProjectFromPath = async (projectPathInput: string) => {
    const projectPath = path.resolve(projectPathInput);
    const info = await stat(projectPath);
    if (!info.isDirectory())
      throw new Error("Selected project must be a folder.");

    return {
      name: path.basename(projectPath),
      path: projectPath,
      modifiedAt: info.mtime.toISOString(),
    };
  };

  const moveProjectFolder = async (
    sourcePath: string,
    destinationPath: string,
  ) => {
    if (sourcePath === destinationPath) return;

    await rename(sourcePath, destinationPath);
  };

  const runProjectCommand = async (
    cwd: string,
    command: string,
    args: string[],
    env = process.env,
  ) => {
    await new Promise<void>((resolve, reject) => {
      const child = spawnTool(command, args, { cwd, env });
      const output: Buffer[] = [];

      child.stdout?.on("data", (chunk) => output.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => output.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        const detail = Buffer.concat(output).toString("utf8").trim();
        reject(new Error(detail || `${command} exited with code ${code}.`));
      });
    });
  };

  const runProjectCommandWithOutput = async (
    cwd: string,
    command: string,
    args: string[],
    env = process.env,
  ) =>
    new Promise<{ stdOut: string; stdErr: string }>((resolve, reject) => {
      const child = spawnTool(command, args, { cwd, env });
      const stdOut: Buffer[] = [];
      const stdErr: Buffer[] = [];

      child.stdout?.on("data", (chunk) => stdOut.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => stdErr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        const result = {
          stdOut: Buffer.concat(stdOut).toString("utf8"),
          stdErr: Buffer.concat(stdErr).toString("utf8"),
        };
        if (code === 0) resolve(result);
        else
          reject(
            new Error(
              result.stdErr.trim() ||
                result.stdOut.trim() ||
                `${command} exited with code ${code}.`,
            ),
          );
      });
    });

  const parseSuiteCloudAccounts = (output: string) =>
    output
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim().split("|")[0]?.trim() ?? "")
      .filter(
        (account, index, accounts) =>
          Boolean(account) && accounts.indexOf(account) === index,
      );

  const getSuiteCloudProjectFolder = (config: string) =>
    config.match(/defaultProjectFolder\s*:\s*['"]([^'"]+)['"]/)?.[1]?.trim() ||
    "src";

  const browserSuiteCloudEnv = () => {
    const env = { ...process.env };
    delete env.SUITECLOUD_CI;
    delete env.SUITECLOUD_CI_PASSKEY;
    delete env.SUITECLOUD_FALLBACK_PASSKEY;
    return env;
  };

  const readDefaultAuthId = async (projectPath: string) => {
    try {
      const value = JSON.parse(
        await readFile(path.join(projectPath, "project.json"), "utf8"),
      ) as {
        defaultAuthId?: unknown;
      };
      return typeof value.defaultAuthId === "string"
        ? value.defaultAuthId
        : undefined;
    } catch {
      return undefined;
    }
  };

  const writeDefaultAuthId = async (projectPath: string, account: string) => {
    const projectJsonPath = path.join(projectPath, "project.json");
    let value: Record<string, unknown> = {};
    try {
      value = JSON.parse(await readFile(projectJsonPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      // A missing project.json is created with the selected default authentication ID.
    }
    value.defaultAuthId = account;
    await writeFile(
      projectJsonPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
  };

  const readFileCabinetFiles = async (
    directoryPath: string,
    relativeDirectory = "",
  ): Promise<
    {
      name: string;
      relativePath: string;
      cabinetPath: string;
    }[]
  > => {
    const files = [];

    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const relativePath = [relativeDirectory, entry.name]
        .filter(Boolean)
        .join("/");
      if (entry.isDirectory()) {
        files.push(
          ...(await readFileCabinetFiles(
            path.join(directoryPath, entry.name),
            relativePath,
          )),
        );
      } else if (entry.isFile()) {
        files.push({
          name: entry.name,
          relativePath,
          cabinetPath: `/${relativePath}`,
        });
      }
    }

    return files;
  };

  const inspectSuiteCloudProject = async (projectPathInput: string) => {
    const projectPath = path.resolve(projectPathInput);

    try {
      const config = await readFile(
        path.join(projectPath, "suitecloud.config.js"),
        "utf8",
      );
      const projectFolder = getSuiteCloudProjectFolder(config);
      const fileCabinetPath = path.resolve(
        projectPath,
        projectFolder,
        "FileCabinet",
      );
      const relativeFileCabinetPath = path.relative(
        projectPath,
        fileCabinetPath,
      );
      if (
        relativeFileCabinetPath.startsWith("..") ||
        path.isAbsolute(relativeFileCabinetPath)
      ) {
        throw new Error(
          "SuiteCloud defaultProjectFolder must stay inside the project.",
        );
      }

      const info = await stat(fileCabinetPath);
      if (!info.isDirectory()) throw new Error("FileCabinet is not a folder.");

      const files = await readFileCabinetFiles(fileCabinetPath);
      let accounts: string[] = [];
      try {
        const result = await runProjectCommandWithOutput(
          projectPath,
          "suitecloud",
          ["account:manageauth", "--list"],
          browserSuiteCloudEnv(),
        );
        accounts = parseSuiteCloudAccounts(result.stdOut);
      } catch {
        // The project is still SDF even when the CLI or its authentication store is unavailable.
      }

      return {
        isSuiteCloud: true,
        projectPath,
        fileCabinetPath,
        files: files.sort((a, b) => a.cabinetPath.localeCompare(b.cabinetPath)),
        accounts,
        defaultAccount: await readDefaultAuthId(projectPath),
      };
    } catch {
      return {
        isSuiteCloud: false,
        projectPath,
        files: [],
        accounts: [] as string[],
      };
    }
  };

  const getCreatedProjectInfo = async (
    projectPath: string,
    template: string,
  ) => {
    try {
      const info = await stat(projectPath);
      if (!info.isDirectory())
        throw new Error("Project path exists but is not a folder.");
      return info;
    } catch (error) {
      if (template === "suitecloud") {
        throw new Error(
          `SuiteCloud project was not created at ${projectPath}. Check the CLI output in the dev console.`,
        );
      }

      if (template === "vue") {
        throw new Error(
          `Vue project was not created at ${projectPath}. Check that pnpm is available and the command completed.`,
        );
      }

      if (template === "git") {
        throw new Error(
          `Git did not clone a project at ${projectPath}. Check that Git is available and the clone completed.`,
        );
      }

      throw error;
    }
  };

  const findCreatedDirectory = async (
    parentPath: string,
    beforePaths: Set<string>,
    expectedPath: string,
    creator = "SuiteCloud",
  ) => {
    try {
      const info = await stat(expectedPath);
      if (info.isDirectory()) return expectedPath;
    } catch {
      // Fall through to compare the directory snapshot.
    }

    const afterPaths = await getDirectoryPaths(parentPath);
    const createdPaths = afterPaths.filter(
      (createdPath) => !beforePaths.has(createdPath),
    );

    if (createdPaths.length === 1) return createdPaths[0];
    if (createdPaths.length > 1) {
      throw new Error(
        `${creator} created multiple folders. Load the intended project manually from ${parentPath}.`,
      );
    }

    throw new Error(
      `${creator} did not create a project folder in ${parentPath}. Check the CLI output in the dev console.`,
    );
  };

  const assertProjectMoveDestinationAvailable = async (
    sourcePath: string,
    destinationPath: string,
  ) => {
    if (sourcePath === destinationPath) return;

    try {
      await access(destinationPath, constants.F_OK);
      throw new Error(
        `A folder named "${path.basename(destinationPath)}" already exists in the target workspace.`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists"))
        throw error;
    }
  };

  const getWorkspace = async (rootPath: string) => {
    const root = path.resolve(rootPath);
    if (!(await stat(root)).isDirectory())
      throw new Error("Choose an existing projects folder.");

    const data = await readHubData(root);
    let changed = false;

    data.groups = data.groups.map((group) => {
      const workspacePath = normalizeWorkspacePath(
        root,
        group.name,
        group.workspacePath,
      );
      if (workspacePath !== group.workspacePath) changed = true;
      return { ...group, workspacePath };
    });

    const excludedProjectPaths = new Set([
      ...data.groups
        .map((group) => group.workspacePath)
        .filter((item): item is string => Boolean(item)),
      ...data.ignoredProjectPaths,
    ]);
    const projects = await getProjects(root, excludedProjectPaths);
    const projectPathSet = new Set(projects.map((project) => project.path));

    for (const savedPath of new Set(
      data.groups.flatMap((group) => group.projectPaths),
    )) {
      if (projectPathSet.has(savedPath)) continue;

      try {
        const project = await getProjectFromPath(savedPath);
        projects.push(project);
        projectPathSet.add(project.path);
      } catch {
        // Missing imported folders are pruned from group metadata below.
      }
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));

    const groups = data.groups.map((group) => {
      const projectPaths = group.projectPaths.filter((projectPath) =>
        projectPathSet.has(projectPath),
      );
      if (projectPaths.length !== group.projectPaths.length) changed = true;

      return {
        id: group.id,
        name: group.name,
        workspacePath: group.workspacePath,
        projectPaths,
        projects: projectPaths
          .map((projectPath) =>
            projects.find((project) => project.path === projectPath),
          )
          .filter(Boolean),
      };
    });

    if (changed) {
      await writeHubData(root, {
        groups: groups.map(({ id, name, workspacePath, projectPaths }) => ({
          id,
          name,
          workspacePath,
          projectPaths,
        })),
        ignoredProjectPaths: data.ignoredProjectPaths,
        terminalState: data.terminalState,
      });
    }

    return {
      rootPath: root,
      projects,
      groups,
      terminalState: data.terminalState,
    };
  };

  const projectsHubApi = () => ({
    name: "projects-hub-api",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/api/workspace", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath } = await readJsonBody(req);
          if (!rootPath)
            return sendJson(res, 400, { error: "rootPath is required" });

          sendJson(res, 200, await getWorkspace(rootPath));
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/groups", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, name, workspacePath } = await readJsonBody(req);
          if (!rootPath || !name)
            return sendJson(res, 400, {
              error: "rootPath and name are required",
            });

          const root = path.resolve(rootPath);
          await mkdir(root, { recursive: true });
          const data = await readHubData(root);
          const groupWorkspacePath = normalizeWorkspacePath(
            root,
            name,
            workspacePath,
          );
          await mkdir(groupWorkspacePath, { recursive: true });
          const group = {
            id: createId(),
            name: name.trim(),
            workspacePath: groupWorkspacePath,
            projectPaths: [],
          };
          data.groups.push(group);
          data.ignoredProjectPaths = data.ignoredProjectPaths.filter(
            (item) => path.resolve(item) !== groupWorkspacePath,
          );
          await writeHubData(root, data);
          sendJson(res, 200, group);
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/projects", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const {
            rootPath,
            groupId,
            name,
            template = "empty",
          } = await readJsonBody(req);
          if (!rootPath || !groupId || !name) {
            return sendJson(res, 400, {
              error: "rootPath, groupId and name are required",
            });
          }

          const root = path.resolve(rootPath);
          const data = await readHubData(root);
          const group = data.groups.find((item) => item.id === groupId);
          if (!group) throw new Error("Group not found.");

          const groupWorkspacePath = normalizeWorkspacePath(
            root,
            group.name,
            group.workspacePath,
          );
          group.workspacePath = groupWorkspacePath;
          await mkdir(groupWorkspacePath, { recursive: true });

          let projectPath = path.join(
            groupWorkspacePath,
            template === "git"
              ? getGitCloneFolderName(name)
              : sanitizeFolderName(name),
          );

          if (template === "vue") {
            const vueProjectFolderName = sanitizePackageName(name);
            const generatedProjectPath = path.join(
              groupWorkspacePath,
              vueProjectFolderName,
            );
            await runProjectCommand(groupWorkspacePath, "pnpm", [
              "create",
              "vue@latest",
              vueProjectFolderName,
              "--ts",
              "--router",
              "--pinia",
              "--bare",
            ]);

            if (generatedProjectPath !== projectPath) {
              await rename(generatedProjectPath, projectPath);
            }
          } else if (template === "suitecloud") {
            const beforePaths = new Set(
              await getDirectoryPaths(groupWorkspacePath),
            );
            await runProjectCommand(groupWorkspacePath, "suitecloud", [
              "project:create",
              "--overwrite",
              "--type",
              "ACCOUNTCUSTOMIZATION",
              "--projectname",
              name.trim(),
            ]);
            projectPath = await findCreatedDirectory(
              groupWorkspacePath,
              beforePaths,
              projectPath,
            );
          } else if (template === "git") {
            const repository = name.trim();
            const beforePaths = new Set(
              await getDirectoryPaths(groupWorkspacePath),
            );
            await runProjectCommand(groupWorkspacePath, "git", [
              "clone",
              repository,
            ]);
            projectPath = await findCreatedDirectory(
              groupWorkspacePath,
              beforePaths,
              projectPath,
              "Git",
            );
          } else {
            await mkdir(projectPath, { recursive: true });
          }

          if (!group.projectPaths.includes(projectPath))
            group.projectPaths.push(projectPath);
          data.ignoredProjectPaths = data.ignoredProjectPaths.filter(
            (item) => path.resolve(item) !== projectPath,
          );
          await writeHubData(root, data);

          const info = await getCreatedProjectInfo(projectPath, template);
          sendJson(res, 200, {
            name: path.basename(projectPath),
            path: projectPath,
            modifiedAt: info.mtime.toISOString(),
          });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/groups/add-project", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const {
            rootPath,
            groupId,
            path: projectPathInput,
          } = await readJsonBody(req);
          if (!rootPath || !groupId || !projectPathInput) {
            return sendJson(res, 400, {
              error: "rootPath, groupId and path are required",
            });
          }

          const project = await getProjectFromPath(projectPathInput);

          const data = await readHubData(rootPath);
          const group = data.groups.find((item) => item.id === groupId);
          if (!group) throw new Error("Group not found.");

          if (!group.projectPaths.includes(project.path))
            group.projectPaths.push(project.path);
          data.ignoredProjectPaths = data.ignoredProjectPaths.filter(
            (item) => path.resolve(item) !== project.path,
          );
          await writeHubData(rootPath, data);

          sendJson(res, 200, { added: project.path });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/groups/rename", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, groupId, name, workspacePath } =
            await readJsonBody(req);
          if (!rootPath || !groupId || !name) {
            return sendJson(res, 400, {
              error: "rootPath, groupId and name are required",
            });
          }

          const nextName = name.trim();
          if (!nextName) throw new Error("Group name is required.");

          const data = await readHubData(rootPath);
          const group = data.groups.find((item) => item.id === groupId);
          if (!group) throw new Error("Group not found.");

          group.name = nextName;
          group.workspacePath = normalizeWorkspacePath(
            rootPath,
            nextName,
            workspacePath ?? group.workspacePath,
          );
          await mkdir(group.workspacePath, { recursive: true });
          await writeHubData(rootPath, data);
          sendJson(res, 200, group);
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/groups/delete", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, groupId } = await readJsonBody(req);
          if (!rootPath || !groupId)
            return sendJson(res, 400, {
              error: "rootPath and groupId are required",
            });

          const data = await readHubData(rootPath);
          const nextGroups = data.groups.filter((item) => item.id !== groupId);
          if (nextGroups.length === data.groups.length)
            throw new Error("Group not found.");

          await writeHubData(rootPath, { ...data, groups: nextGroups });
          sendJson(res, 200, { deleted: groupId });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/groups/reorder", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, groupIds } = await readJsonBody(req);
          if (!rootPath || !Array.isArray(groupIds))
            return sendJson(res, 400, {
              error: "rootPath and groupIds are required",
            });

          const data = await readHubData(rootPath);
          const groupById = new Map(
            data.groups.map((group) => [group.id, group]),
          );
          const orderedGroups = groupIds
            .map((groupId) => groupById.get(groupId))
            .filter((group): group is HubGroup => Boolean(group));

          if (orderedGroups.length !== data.groups.length)
            throw new Error("Group order did not include every group.");

          await writeHubData(rootPath, { ...data, groups: orderedGroups });
          sendJson(res, 200, { reordered: orderedGroups.length });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/groups/move-projects", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, groupId, paths } = await readJsonBody(req);
          if (!rootPath || !groupId || !Array.isArray(paths)) {
            return sendJson(res, 400, {
              error: "rootPath, groupId and paths are required",
            });
          }

          const data = await readHubData(rootPath);
          const targetGroup = data.groups.find((item) => item.id === groupId);
          if (!targetGroup) throw new Error("Group not found.");

          const targetWorkspacePath = normalizeWorkspacePath(
            rootPath,
            targetGroup.name,
            targetGroup.workspacePath,
          );
          targetGroup.workspacePath = targetWorkspacePath;
          await mkdir(targetWorkspacePath, { recursive: true });

          const movedPathByOriginal = new Map<string, string>();
          const projectPaths = await Promise.all(
            paths.map(
              async (projectPathInput) =>
                (await getProjectFromPath(projectPathInput)).path,
            ),
          );

          for (const projectPath of projectPaths) {
            const nextProjectPath = path.join(
              targetWorkspacePath,
              path.basename(projectPath),
            );
            await assertProjectMoveDestinationAvailable(
              projectPath,
              nextProjectPath,
            );
            movedPathByOriginal.set(projectPath, nextProjectPath);
          }

          for (const projectPath of projectPaths) {
            const nextProjectPath =
              movedPathByOriginal.get(projectPath) ?? projectPath;

            try {
              await moveProjectFolder(projectPath, nextProjectPath);
            } catch (error) {
              const detail = error as { code?: string };
              if (detail.code !== "EXDEV") throw error;

              await cp(projectPath, nextProjectPath, {
                recursive: true,
                force: false,
                errorOnExist: true,
              });
              await rm(projectPath, { recursive: true, force: true });
            }
          }

          const moving = new Set(projectPaths);
          for (const group of data.groups) {
            group.projectPaths = group.projectPaths.filter(
              (projectPath) => !moving.has(projectPath),
            );
            if (group.id === groupId) {
              const movedPaths = projectPaths.map(
                (projectPath) =>
                  movedPathByOriginal.get(projectPath) ?? projectPath,
              );
              group.projectPaths = Array.from(
                new Set([...group.projectPaths, ...movedPaths]),
              );
            }
          }

          await writeHubData(rootPath, data);
          sendJson(res, 200, { moved: paths.length });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/projects/delete", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const {
            rootPath,
            path: projectPathInput,
            deleteFolder,
          } = await readJsonBody(req);
          if (!rootPath || !projectPathInput)
            return sendJson(res, 400, {
              error: "rootPath and path are required",
            });

          const projectPath = path.resolve(projectPathInput);
          const root = path.resolve(rootPath);
          const relativeRoot = path.relative(projectPath, root);
          if (
            projectPath === root ||
            (!relativeRoot.startsWith("..") && !path.isAbsolute(relativeRoot))
          )
            throw Error(
              "The projects root and its parent folders cannot be deleted.",
            );
          const known = await getWorkspace(root);
          if (
            !known.projects.some(
              (project) =>
                path.resolve(project.path).toLowerCase() ===
                projectPath.toLowerCase(),
            )
          )
            throw Error(
              "This folder is not a registered project in this workspace.",
            );
          const data = await readHubData(rootPath);
          let removedFromGroups = 0;

          for (const group of data.groups) {
            const nextProjectPaths = group.projectPaths.filter(
              (item) => path.resolve(item) !== projectPath,
            );
            if (nextProjectPaths.length !== group.projectPaths.length)
              removedFromGroups += 1;
            group.projectPaths = nextProjectPaths;
          }

          if (deleteFolder) {
            const info = await stat(projectPath);
            if (!info.isDirectory())
              throw new Error("Selected project must be a folder.");
            await rm(projectPath, { recursive: true, force: true });
            data.ignoredProjectPaths = data.ignoredProjectPaths.filter(
              (item) => path.resolve(item) !== projectPath,
            );
          } else if (
            !data.ignoredProjectPaths.some(
              (item) => path.resolve(item) === projectPath,
            )
          ) {
            data.ignoredProjectPaths.push(projectPath);
          }

          await writeHubData(rootPath, data);
          sendJson(res, 200, {
            deleted: projectPath,
            removedFromGroups,
            folderDeleted: Boolean(deleteFolder),
          });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/open-code", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, path: target } = await readJsonBody(req);
          if (!rootPath || !target)
            return sendJson(res, 400, {
              error: "rootPath and path are required",
            });

          const targetPath = path.resolve(target);
          await access(targetPath, constants.F_OK);

          await runProjectCommand(path.dirname(targetPath), "code", [
            targetPath,
          ]);

          sendJson(res, 200, { opened: targetPath });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });
      server.middlewares.use("/api/open-explorer", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, path: target } = await readJsonBody(req);
          if (!rootPath || !target)
            return sendJson(res, 400, {
              error: "rootPath and path are required",
            });

          const targetPath = path.resolve(target);
          await access(targetPath, constants.F_OK);

          const child = spawn("explorer.exe", [targetPath], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.unref();

          sendJson(res, 200, { opened: targetPath });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/suitecloud/inspect", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { path: projectPath } = await readJsonBody(req);
          if (!projectPath)
            return sendJson(res, 400, { error: "path is required" });

          sendJson(res, 200, await inspectSuiteCloudProject(projectPath));
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/suitecloud/login", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { path: projectPathInput } = await readJsonBody(req);
          if (!projectPathInput)
            return sendJson(res, 400, { error: "path is required" });

          const project = await inspectSuiteCloudProject(projectPathInput);
          if (!project.isSuiteCloud)
            throw new Error(
              "Selected folder is not an SDF SuiteCloud project.",
            );
          if (process.platform !== "win32") {
            throw new Error(
              "Interactive SuiteCloud browser login currently requires Windows.",
            );
          }

          const child = spawn(
            process.env.ComSpec || "cmd.exe",
            ["/D", "/K", "suitecloud account:setup"],
            {
              cwd: project.projectPath,
              detached: true,
              env: browserSuiteCloudEnv(),
              stdio: "ignore",
              windowsHide: false,
            },
          );
          child.unref();
          sendJson(res, 200, { opened: true });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/suitecloud/upload", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const {
            path: projectPathInput,
            paths,
            account,
          } = await readJsonBody(req);
          if (
            !projectPathInput ||
            !Array.isArray(paths) ||
            paths.length === 0 ||
            !account
          ) {
            return sendJson(res, 400, {
              error: "path, paths and account are required",
            });
          }

          const project = await inspectSuiteCloudProject(projectPathInput);
          if (!project.isSuiteCloud)
            throw new Error(
              "Selected folder is not an SDF SuiteCloud project.",
            );

          const availablePaths = new Set(
            project.files.map((file) => file.cabinetPath),
          );
          if (
            paths.some(
              (filePath) =>
                typeof filePath !== "string" || !availablePaths.has(filePath),
            )
          ) {
            throw new Error(
              "One or more selected paths are not files in this project FileCabinet folder.",
            );
          }

          const accountResult = await runProjectCommandWithOutput(
            project.projectPath,
            "suitecloud",
            ["account:manageauth", "--list"],
            browserSuiteCloudEnv(),
          );
          const accounts = parseSuiteCloudAccounts(accountResult.stdOut);
          if (!accounts.includes(account))
            throw new Error(
              "Selected SuiteCloud authentication ID is not configured.",
            );

          await writeDefaultAuthId(project.projectPath, account);
          await runProjectCommand(
            project.projectPath,
            "suitecloud",
            ["file:upload", "--paths", ...paths],
            browserSuiteCloudEnv(),
          );

          sendJson(res, 200, { uploaded: paths.length, account });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/terminal/state", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, terminalState } = await readJsonBody(req);
          if (!rootPath)
            return sendJson(res, 400, { error: "rootPath is required" });

          const data = await readHubData(rootPath);
          data.terminalState = normalizeTerminalState(terminalState);
          await writeHubData(rootPath, data);

          sendJson(res, 200, {
            saved: true,
            terminalState: data.terminalState,
          });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

      server.middlewares.use("/api/terminal/run", async (req, res) => {
        try {
          if (req.method !== "POST")
            return sendJson(res, 405, { error: "Method not allowed" });

          const { rootPath, path: cwdInput, command } = await readJsonBody(req);
          if (!rootPath || !cwdInput || !command) {
            return sendJson(res, 400, {
              error: "rootPath, path and command are required",
            });
          }

          const cwd = path.resolve(cwdInput);
          const info = await stat(cwd);
          if (!info.isDirectory())
            throw new Error("Terminal path must be a folder.");

          const child = spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            timeout: 120000,
          });
          const stdOut: Buffer[] = [];
          const stdErr: Buffer[] = [];

          child.stdout?.on("data", (chunk) => stdOut.push(Buffer.from(chunk)));
          child.stderr?.on("data", (chunk) => stdErr.push(Buffer.from(chunk)));
          child.on("error", (error) =>
            sendJson(res, 500, { error: error.message }),
          );
          child.on("close", (code) => {
            sendJson(res, 200, {
              stdOut: Buffer.concat(stdOut).toString("utf8"),
              stdErr: Buffer.concat(stdErr).toString("utf8"),
              exitCode: code ?? 0,
            });
          });
        } catch (error) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });
    },
  });

  const handlers = new Map<
    string,
    (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => unknown
  >();
  projectsHubApi().configureServer({
    middlewares: {
      use(
        route: string,
        handler: typeof handlers extends Map<string, infer H> ? H : never,
      ) {
        handlers.set(route.replace("/api/", ""), handler);
      },
    },
  } as unknown as import("vite").ViteDevServer);
  const folders = new GitService(directory, filename);
  return {
    async invoke(operation: string, payload: Record<string, unknown> = {}) {
      if (operation.endsWith("/delete") && payload.confirmed !== true)
        throw Error("Confirm the deletion before continuing.");
      if (operation === "folders")
        return folders.invoke("git_folders", payload);
      const handler = handlers.get(operation);
      if (!handler) throw Error("Unknown Projects Hub operation.");
      if (
        payload.rootPath &&
        (typeof payload.rootPath !== "string" ||
          !path.isAbsolute(payload.rootPath))
      )
        throw Error("An absolute projects root is required.");
      return new Promise<unknown>((resolve, reject) => {
        const req = Readable.from([
          Buffer.from(JSON.stringify(payload)),
        ]) as import("node:http").IncomingMessage;
        req.method = "POST";
        const res = {
          statusCode: 200,
          setHeader() {},
          end(this: { statusCode: number }, text: string) {
            const data = JSON.parse(text);
            if (this.statusCode >= 400) reject(Error(data.error));
            else resolve(data);
          },
        } as unknown as import("node:http").ServerResponse;
        Promise.resolve(handler(req, res)).catch(reject);
      });
    },
    close() {
      folders.close();
      database.close();
    },
  };
}
