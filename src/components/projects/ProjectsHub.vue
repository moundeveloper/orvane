<script setup lang="ts">
import Neutralino from "@neutralinojs/lib";
import {
  Code2,
  Check,
  CloudUpload,
  Edit3,
  Folder,
  FolderOpen,
  FolderGit2,
  Home,
  Plus,
  RefreshCw,
  Search,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "@lucide/vue";
import { computed, onMounted, ref, watch, onBeforeUnmount } from "vue";
import type { Block } from "../../model";
import "./projects.css";
const props = defineProps<{ block: Block; editing: boolean }>();

import BaseSelect from "./BaseSelect.vue";
import GroupActionModal from "./GroupActionModal.vue";
import SuiteCloudUploadView from "./SuiteCloudUploadView.vue";
import TerminalPanel from "./TerminalPanel.vue";
import type {
  Group,
  Project,
  SelectOption,
  SuiteCloudFile,
  SuiteCloudProjectInfo,
  TerminalState,
} from "./types";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name: string }>;
};

type Workspace = {
  rootPath: string;
  projects: Project[];
  groups: Group[];
  ignoredProjectPaths?: string[];
  terminalState?: TerminalState;
};

type ProjectTemplate = "empty" | "vue" | "suitecloud" | "git";
type TerminalCommandResult = {
  stdOut: string;
  stdErr: string;
  exitCode: number;
};
type TerminalPanelInstance = InstanceType<typeof TerminalPanel> & {
  addTab: (cwd?: string, title?: string) => Promise<void>;
};

const STORAGE_KEY = "projects-hub:root-path";
const SETTINGS_FOLDER = "ProjectsHub";
const ALL_PROJECTS_ID = "__all__";
const METADATA_FILE = ".projects-hub.json";

const rootPath = ref(props.block.value || "");
const workspace = ref<Workspace | null>(null);
const activeGroupId = ref(ALL_PROJECTS_ID);
const searchQuery = ref("");
const groupName = ref("");
const groupWorkspacePath = ref("");
const projectName = ref("");
const projectTemplate = ref<ProjectTemplate>("empty");
const importedProjectPath = ref("");
const projectGroupId = ref("");
const selectedProjectPaths = ref<Set<string>>(new Set());
const lastSelectedProjectPath = ref("");
const showCreateGroupPanel = ref(false);
const showRenameGroupPanel = ref(false);
const groupToRenameId = ref("");
const renameGroupName = ref("");
const renameGroupWorkspacePath = ref("");
const groupPanelMode = ref<"move" | null>(null);
const targetGroupId = ref("");
const draggedGroupId = ref("");
const dragOverGroupId = ref("");
const contextMenu = ref<{
  x: number;
  y: number;
  projectPath: string;
  suiteCloudState: "checking" | "available" | "unavailable";
} | null>(null);
const suiteCloudProject = ref<Project | null>(null);
const suiteCloudInfo = ref<SuiteCloudProjectInfo | null>(null);
const isSuiteCloudUploading = ref(false);
const isSuiteCloudRefreshing = ref(false);
const terminalPanel = ref<TerminalPanelInstance | null>(null);
const isLoading = ref(false);
const isPickingFolder = ref(false);
const browserPickedProjectFolderName = ref("");
const statusMessage = ref("");
const errorMessage = ref("");

const isNeutralino = () =>
  typeof (globalThis as { NL_MODE?: string }).NL_MODE === "string";

const getNativeDataRootPath = async () => {
  const configPath = await Neutralino.os.getPath("config");
  const settingsDir = await Neutralino.filesystem.getJoinedPath(
    configPath,
    SETTINGS_FOLDER,
  );

  try {
    const stats = await Neutralino.filesystem.getStats(settingsDir);
    if (!stats.isDirectory)
      throw new Error("Projects Hub data path exists and is not a folder.");
  } catch {
    await Neutralino.filesystem.createDirectory(settingsDir);
  }

  return settingsDir;
};

const readSavedRootPath = async () => props.block.value || "";

const joinPath = async (...parts: string[]) => {
  if (isNeutralino()) {
    return Neutralino.filesystem.getJoinedPath(...parts);
  }

  return parts
    .join("\\")
    .replace(/[\\/]+/g, "\\")
    .replace(/^([A-Za-z]:)\\/, "$1\\");
};

const sanitizePathSegment = (name: string) => {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ");

  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("Enter a valid folder name.");
  }

  return cleaned;
};

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

const getDefaultGroupWorkspacePath = async (groupLabel: string) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");
  return joinPath(workspace.value.rootPath, sanitizePathSegment(groupLabel));
};

const hasWorkspace = computed(() => Boolean(rootPath.value && workspace.value));
const allProjects = computed(() => workspace.value?.projects ?? []);
const totalProjects = computed(() => allProjects.value.length);

const groupedProjectPaths = computed(() => {
  const paths = new Set<string>();
  workspace.value?.groups.forEach((group) => {
    group.projectPaths.forEach((projectPath) => paths.add(projectPath));
  });
  return paths;
});

const ungroupedCount = computed(
  () =>
    allProjects.value.filter(
      (project) => !groupedProjectPaths.value.has(project.path),
    ).length,
);

const selectedProjects = computed(() =>
  allProjects.value.filter((project) =>
    selectedProjectPaths.value.has(project.path),
  ),
);

const selectableFilteredProjectPaths = computed(() =>
  filteredProjects.value.map((project) => project.path),
);

const allFilteredProjectsSelected = computed(
  () =>
    selectableFilteredProjectPaths.value.length > 0 &&
    selectableFilteredProjectPaths.value.every((projectPath) =>
      selectedProjectPaths.value.has(projectPath),
    ),
);

const projectGroupOptions = computed<SelectOption[]>(() =>
  (workspace.value?.groups ?? []).map((group) => ({
    value: group.id,
    label: group.name,
    description: `${group.projects.length} project${group.projects.length === 1 ? "" : "s"}`,
  })),
);

const projectTemplateOptions = computed<SelectOption[]>(() => [
  { value: "empty", label: "Empty", description: "Create an empty folder" },
  { value: "vue", label: "Vue", description: "pnpm create vue@latest" },
  {
    value: "suitecloud",
    label: "SuiteCloud",
    description: "suitecloud project:create",
  },
  {
    value: "git",
    label: "Git clone",
    description: "Clone a repository into the group workspace",
  },
]);

const projectNamePlaceholder = computed(() =>
  projectTemplate.value === "git"
    ? "Repository URL"
    : "New project folder name",
);

const activeGroup = computed(() => {
  if (!workspace.value || activeGroupId.value === ALL_PROJECTS_ID) {
    return {
      id: ALL_PROJECTS_ID,
      name: "All Projects",
      projects: allProjects.value,
      projectPaths: [],
    };
  }

  return (
    workspace.value.groups.find(
      (group) => group.id === activeGroupId.value,
    ) ?? {
      id: ALL_PROJECTS_ID,
      name: "All Projects",
      projects: allProjects.value,
      projectPaths: [],
    }
  );
});

const filteredProjects = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const projects = activeGroup.value.projects.map((project) => ({
    ...project,
    groupName: activeGroup.value.name,
  }));

  if (!query) return projects;

  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(query) ||
      project.path.toLowerCase().includes(query) ||
      project.groupName.toLowerCase().includes(query),
  );
});

const groupedSearchResults = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  if (!query || !workspace.value) return [];

  return [
    {
      id: ALL_PROJECTS_ID,
      name: "All Projects",
      projects: allProjects.value.filter(
        (project) =>
          project.name.toLowerCase().includes(query) ||
          project.path.toLowerCase().includes(query),
      ),
    },
    ...workspace.value.groups.map((group) => ({
      id: group.id,
      name: group.name,
      projects: group.projects.filter(
        (project) =>
          project.name.toLowerCase().includes(query) ||
          project.path.toLowerCase().includes(query) ||
          group.name.toLowerCase().includes(query),
      ),
    })),
  ].filter((group) => group.projects.length > 0);
});

const request = async <T,>(
  url: string,
  body: Record<string, unknown> = {},
): Promise<T> => {
  const response = await fetch(url.replace("/api/", "/__orvane/projects/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      url.endsWith("/delete") ? { ...body, confirmed: true } : body,
    ),
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }

  return payload;
};

const formatError = (error: unknown, fallback: string) => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const detail = error as { code?: string; message?: string };
    if (detail.code || detail.message) {
      return [detail.code, detail.message].filter(Boolean).join(": ");
    }

    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }

  return fallback;
};

const assertNativePathMissing = async (
  targetPath: string,
  folderName: string,
) => {
  try {
    await Neutralino.filesystem.getStats(targetPath);
    throw new Error(
      `A folder named "${folderName}" already exists in the target workspace.`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists"))
      throw error;
  }
};

const moveNativeProjectFolder = async (
  sourcePath: string,
  destinationPath: string,
) => {
  if (sourcePath === destinationPath) return;

  try {
    await Neutralino.filesystem.move(sourcePath, destinationPath);
    return;
  } catch (error) {
    console.error(
      "Native folder move failed. Trying copy/remove fallback.",
      error,
    );
  }

  await Neutralino.filesystem.copy(sourcePath, destinationPath, {
    recursive: true,
    overwrite: false,
    skip: false,
  });
  await Neutralino.filesystem.remove(sourcePath);
};

const quoteCommandArg = (value: string) => `"${value.replace(/"/g, '\\"')}"`;

const getGitCloneFolderName = (repository: string) => {
  if (/["\r\n]/.test(repository))
    throw new Error("Enter a valid Git repository URL.");

  const normalized = repository
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/[\\/]+$/, "");
  const folderName =
    normalized
      .split(/[\\/:]/)
      .pop()
      ?.replace(/\.git$/i, "") ?? "";
  return sanitizePathSegment(folderName);
};

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

const browserSuiteCloudCommand = (command: string) =>
  `set SUITECLOUD_CI=&&set SUITECLOUD_CI_PASSKEY=&&set SUITECLOUD_FALLBACK_PASSKEY=&&${command}`;

const readNativeDefaultAuthId = async (projectPath: string) => {
  try {
    const raw = await Neutralino.filesystem.readFile(
      await joinPath(projectPath, "project.json"),
    );
    const value = JSON.parse(raw) as { defaultAuthId?: unknown };
    return typeof value.defaultAuthId === "string"
      ? value.defaultAuthId
      : undefined;
  } catch {
    return undefined;
  }
};

const writeNativeDefaultAuthId = async (
  projectPath: string,
  account: string,
) => {
  const projectJsonPath = await joinPath(projectPath, "project.json");
  let value: Record<string, unknown> = {};
  try {
    value = JSON.parse(
      await Neutralino.filesystem.readFile(projectJsonPath),
    ) as Record<string, unknown>;
  } catch {
    // A missing project.json is created with the selected default authentication ID.
  }
  value.defaultAuthId = account;
  await Neutralino.filesystem.writeFile(
    projectJsonPath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
};

const readNativeFileCabinetFiles = async (
  directoryPath: string,
  relativeDirectory = "",
): Promise<SuiteCloudFile[]> => {
  const entries = await Neutralino.filesystem.readDirectory(directoryPath);
  const files: SuiteCloudFile[] = [];

  for (const entry of entries) {
    const relativePath = [relativeDirectory, entry.entry]
      .filter(Boolean)
      .join("/");

    if (entry.type === "DIRECTORY") {
      files.push(
        ...(await readNativeFileCabinetFiles(entry.path, relativePath)),
      );
    } else if (entry.type === "FILE") {
      files.push({
        name: entry.entry,
        relativePath,
        cabinetPath: `/${relativePath}`,
      });
    }
  }

  return files;
};

const inspectNativeSuiteCloudProject = async (
  projectPath: string,
): Promise<SuiteCloudProjectInfo> => {
  let fileCabinetPath = "";
  try {
    const configPath = await joinPath(projectPath, "suitecloud.config.js");
    const config = await Neutralino.filesystem.readFile(configPath);
    const projectFolder = getSuiteCloudProjectFolder(config);
    fileCabinetPath = await joinPath(projectPath, projectFolder, "FileCabinet");
    const stats = await Neutralino.filesystem.getStats(fileCabinetPath);
    if (!stats.isDirectory) throw new Error("FileCabinet is not a folder.");
  } catch {
    return { isSuiteCloud: false, projectPath, files: [], accounts: [] };
  }

  const files = await readNativeFileCabinetFiles(fileCabinetPath);
  let accounts: string[] = [];
  try {
    const accountResult = await Neutralino.os.execCommand(
      browserSuiteCloudCommand("suitecloud account:manageauth --list"),
      { cwd: projectPath },
    );
    if (accountResult.exitCode === 0)
      accounts = parseSuiteCloudAccounts(accountResult.stdOut ?? "");
  } catch {
    // The folder remains a valid SDF project when the CLI or authentication store is unavailable.
  }

  return {
    isSuiteCloud: true,
    projectPath,
    fileCabinetPath,
    files: files.sort((a, b) => a.cabinetPath.localeCompare(b.cabinetPath)),
    accounts,
    defaultAccount: await readNativeDefaultAuthId(projectPath),
  };
};

const runNativeProjectCommand = async (cwd: string, command: string) => {
  const result = await Neutralino.os.execCommand(command, { cwd });

  if (result.exitCode !== 0) {
    throw new Error(
      result.stdErr ||
        result.stdOut ||
        `${command} exited with code ${result.exitCode}.`,
    );
  }
};

const ensureNativeDirectory = async (directoryPath: string, label: string) => {
  try {
    await Neutralino.filesystem.createDirectory(directoryPath);
  } catch {
    const stats = await Neutralino.filesystem.getStats(directoryPath);
    if (!stats.isDirectory) throw new Error(`${label} must be a folder.`);
  }
};

const getNativeProjectStats = async (
  projectPath: string,
  template: ProjectTemplate,
) => {
  try {
    const stats = await Neutralino.filesystem.getStats(projectPath);
    if (!stats.isDirectory)
      throw new Error("Project path exists but is not a folder.");
    return stats;
  } catch (error) {
    if (template === "suitecloud") {
      throw new Error(
        `SuiteCloud project was not created at ${projectPath}. Check the dev console for CLI output.`,
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

const readHubData = async (selectedRoot: string) => {
  try {
    const metadataPath = await joinPath(selectedRoot, METADATA_FILE);
    const raw = await Neutralino.filesystem.readFile(metadataPath);
    const parsed = JSON.parse(raw) as {
      groups?: Group[];
      ignoredProjectPaths?: string[];
      terminalState?: TerminalState;
    };

    return {
      groups: Array.isArray(parsed.groups)
        ? parsed.groups.map((group) => ({
            id: group.id,
            name: group.name,
            workspacePath:
              typeof group.workspacePath === "string" &&
              group.workspacePath.trim()
                ? group.workspacePath
                : undefined,
            projectPaths: Array.isArray(group.projectPaths)
              ? group.projectPaths
              : [],
            projects: [],
          }))
        : [],
      ignoredProjectPaths: Array.isArray(parsed.ignoredProjectPaths)
        ? parsed.ignoredProjectPaths
        : [],
      terminalState: normalizeTerminalState(parsed.terminalState),
    };
  } catch {
    return {
      groups: [] as Group[],
      ignoredProjectPaths: [] as string[],
      terminalState: undefined,
    };
  }
};

const normalizeTerminalState = (state: unknown): TerminalState | undefined => {
  if (!state || typeof state !== "object") return undefined;

  const value = state as TerminalState;
  return {
    isOpen: typeof value.isOpen === "boolean" ? value.isOpen : undefined,
    isMaximized:
      typeof value.isMaximized === "boolean" ? value.isMaximized : undefined,
    height: typeof value.height === "number" ? value.height : undefined,
    activeCwd:
      typeof value.activeCwd === "string" ? value.activeCwd : undefined,
    tabs: Array.isArray(value.tabs)
      ? value.tabs
          .filter((tab) => tab && typeof tab.cwd === "string" && tab.cwd.trim())
          .map((tab) => ({
            cwd: tab.cwd,
            title:
              typeof tab.title === "string" && tab.title.trim()
                ? tab.title
                : tab.cwd.split(/[\\/]/).pop() || tab.cwd,
          }))
      : undefined,
  };
};

const writeHubData = async (
  selectedRoot: string,
  groups: Group[],
  ignoredProjectPaths: string[] = [],
  terminalState: TerminalState | undefined = workspace.value?.terminalState,
) => {
  const metadataPath = await joinPath(selectedRoot, METADATA_FILE);
  const payload = {
    groups: groups.map(({ id, name, workspacePath, projectPaths }) => ({
      id,
      name,
      workspacePath,
      projectPaths,
    })),
    ignoredProjectPaths,
    terminalState: normalizeTerminalState(terminalState),
  };

  await Neutralino.filesystem.writeFile(
    metadataPath,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
};

const readProjectFolders = async (
  parentPath: string,
  excludedPaths = new Set<string>(),
) => {
  const entries = await Neutralino.filesystem.readDirectory(parentPath);
  const projects: Project[] = [];

  for (const entry of entries) {
    if (entry.type !== "DIRECTORY") continue;
    if (entry.entry === "node_modules" || entry.entry === ".git") continue;
    if (excludedPaths.has(entry.path)) continue;

    const stats = await Neutralino.filesystem.getStats(entry.path);
    projects.push({
      name: entry.entry,
      path: entry.path,
      modifiedAt: new Date(stats.modifiedAt).toISOString(),
    });
  }

  return projects;
};

const readDirectoryPaths = async (parentPath: string) => {
  const entries = await Neutralino.filesystem.readDirectory(parentPath);
  return entries
    .filter(
      (entry) => entry.type === "DIRECTORY" && typeof entry.path === "string",
    )
    .map((entry) => entry.path as string);
};

const findNativeCreatedDirectory = async (
  parentPath: string,
  beforePaths: Set<string>,
  expectedPath: string,
  creator = "SuiteCloud",
): Promise<string> => {
  try {
    const stats = await Neutralino.filesystem.getStats(expectedPath);
    if (stats.isDirectory) return expectedPath;
  } catch {
    // Fall through to compare the directory snapshot.
  }

  const afterPaths = await readDirectoryPaths(parentPath);
  const createdPaths = afterPaths.filter((path) => !beforePaths.has(path));

  const createdPath = createdPaths[0];
  if (createdPaths.length === 1 && createdPath) return createdPath;
  if (createdPaths.length > 1) {
    throw new Error(
      `${creator} created multiple folders. Load the intended project manually from ${parentPath}.`,
    );
  }

  throw new Error(
    `${creator} did not create a project folder in ${parentPath}. Check the dev console for CLI output.`,
  );
};

const getNativeWorkspace = async (selectedRoot: string): Promise<Workspace> => {
  const rootStats = await Neutralino.filesystem.getStats(selectedRoot);
  if (!rootStats.isDirectory) {
    throw new Error("Library folder must be a folder.");
  }

  const data = await readHubData(selectedRoot);
  let changed = false;

  const normalizedGroups = [];
  for (const group of data.groups) {
    const workspacePath =
      group.workspacePath ||
      (await joinPath(selectedRoot, sanitizePathSegment(group.name)));
    if (workspacePath !== group.workspacePath) changed = true;
    normalizedGroups.push({ ...group, workspacePath });
  }
  data.groups = normalizedGroups;

  const excludedProjectPaths = new Set([
    ...data.groups
      .map((group) => group.workspacePath)
      .filter((item): item is string => Boolean(item)),
    ...data.ignoredProjectPaths,
  ]);
  const projects = await readProjectFolders(selectedRoot, excludedProjectPaths);
  const projectPaths = new Set(projects.map((project) => project.path));

  for (const savedPath of new Set(
    data.groups.flatMap((group) => group.projectPaths),
  )) {
    if (projectPaths.has(savedPath)) continue;

    try {
      const stats = await Neutralino.filesystem.getStats(savedPath);
      if (!stats.isDirectory) continue;

      projects.push({
        name: savedPath.split(/[\\/]/).pop() || savedPath,
        path: savedPath,
        modifiedAt: new Date(stats.modifiedAt).toISOString(),
      });
      projectPaths.add(savedPath);
    } catch {
      // Missing imported folders are pruned from group metadata below.
    }
  }

  projects.sort((a, b) => a.name.localeCompare(b.name));

  const groups = data.groups.map((group) => {
    const validProjectPaths = group.projectPaths.filter((projectPath) =>
      projectPaths.has(projectPath),
    );
    if (validProjectPaths.length !== group.projectPaths.length) changed = true;

    return {
      ...group,
      projectPaths: validProjectPaths,
      projects: validProjectPaths
        .map((projectPath) =>
          projects.find((project) => project.path === projectPath),
        )
        .filter((project): project is Project => Boolean(project)),
    };
  });

  if (changed)
    await writeHubData(
      selectedRoot,
      groups,
      data.ignoredProjectPaths,
      data.terminalState,
    );

  return {
    rootPath: selectedRoot,
    projects,
    groups,
    ignoredProjectPaths: data.ignoredProjectPaths,
    terminalState: data.terminalState,
  };
};

const createNativeGroup = async (name: string, workspacePathInput = "") => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  const workspacePath =
    workspacePathInput.trim() || (await getDefaultGroupWorkspacePath(name));
  try {
    await Neutralino.filesystem.createDirectory(workspacePath);
  } catch {
    const stats = await Neutralino.filesystem.getStats(workspacePath);
    if (!stats.isDirectory)
      throw new Error("Group workspace path must be a folder.");
  }

  const group: Group = {
    id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim(),
    workspacePath,
    projectPaths: [],
    projects: [],
  };
  const groups = [...workspace.value.groups, group];
  await writeHubData(
    workspace.value.rootPath,
    groups,
    workspace.value.ignoredProjectPaths,
  );

  return group;
};

const renameNativeGroup = async (
  groupId: string,
  name: string,
  workspacePathInput = "",
) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  const nextName = name.trim();
  if (!nextName) throw new Error("Group name is required.");

  const workspacePath =
    workspacePathInput.trim() || (await getDefaultGroupWorkspacePath(nextName));
  try {
    await Neutralino.filesystem.createDirectory(workspacePath);
  } catch {
    const stats = await Neutralino.filesystem.getStats(workspacePath);
    if (!stats.isDirectory)
      throw new Error("Group workspace path must be a folder.");
  }

  const groups = workspace.value.groups.map((group) =>
    group.id === groupId ? { ...group, name: nextName, workspacePath } : group,
  );
  if (!workspace.value.groups.some((group) => group.id === groupId))
    throw new Error("Group not found.");

  await writeHubData(
    workspace.value.rootPath,
    groups,
    workspace.value.ignoredProjectPaths,
  );
};

const deleteNativeGroup = async (groupId: string) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  const groups = workspace.value.groups.filter((group) => group.id !== groupId);
  if (groups.length === workspace.value.groups.length)
    throw new Error("Group not found.");

  await writeHubData(
    workspace.value.rootPath,
    groups,
    workspace.value.ignoredProjectPaths,
  );
};

const reorderNativeGroups = async (orderedGroups: Group[]) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");
  await writeHubData(
    workspace.value.rootPath,
    orderedGroups,
    workspace.value.ignoredProjectPaths,
  );
};

const createNativeProject = async (
  name: string,
  groupId: string,
  template: ProjectTemplate,
) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  const group = workspace.value.groups.find((item) => item.id === groupId);
  if (!group) throw new Error("Group not found.");

  const parentPath =
    group.workspacePath || (await getDefaultGroupWorkspacePath(group.name));
  await ensureNativeDirectory(parentPath, "Project location");

  const projectFolderName =
    template === "git"
      ? getGitCloneFolderName(name)
      : sanitizePathSegment(name);
  let projectPath = await joinPath(parentPath, projectFolderName);

  if (template === "vue") {
    const vueProjectFolderName = sanitizePackageName(name);
    const generatedProjectPath = await joinPath(
      parentPath,
      vueProjectFolderName,
    );
    await runNativeProjectCommand(
      parentPath,
      `pnpm create vue@latest ${quoteCommandArg(vueProjectFolderName)} --ts --router --pinia --bare`,
    );

    if (generatedProjectPath !== projectPath) {
      await Neutralino.filesystem.move(generatedProjectPath, projectPath);
    }
  } else if (template === "suitecloud") {
    const beforePaths = new Set(await readDirectoryPaths(parentPath));
    await runNativeProjectCommand(
      parentPath,
      `suitecloud project:create --overwrite --type ACCOUNTCUSTOMIZATION --projectname ${quoteCommandArg(name.trim())}`,
    );
    projectPath = await findNativeCreatedDirectory(
      parentPath,
      beforePaths,
      projectPath,
    );
  } else if (template === "git") {
    const repository = name.trim();
    const beforePaths = new Set(await readDirectoryPaths(parentPath));
    await runNativeProjectCommand(
      parentPath,
      `git clone ${quoteCommandArg(repository)}`,
    );
    projectPath = await findNativeCreatedDirectory(
      parentPath,
      beforePaths,
      projectPath,
      "Git",
    );
  } else {
    await Neutralino.filesystem.createDirectory(projectPath);
  }

  const stats = await getNativeProjectStats(projectPath, template);
  const ignoredProjectPaths = (
    workspace.value.ignoredProjectPaths ?? []
  ).filter((path) => path !== projectPath);
  const groups = workspace.value.groups.map((group) =>
    group.id === groupId && !group.projectPaths.includes(projectPath)
      ? { ...group, projectPaths: [...group.projectPaths, projectPath] }
      : group,
  );

  await writeHubData(workspace.value.rootPath, groups, ignoredProjectPaths);

  return {
    name: projectPath.split(/[\\/]/).pop() || name.trim(),
    path: projectPath,
    modifiedAt: new Date(stats.modifiedAt).toISOString(),
  };
};

const deleteNativeProject = async (
  projectPath: string,
  deleteFolder: boolean,
) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  const groups = workspace.value.groups.map((group) => ({
    ...group,
    projectPaths: group.projectPaths.filter((path) => path !== projectPath),
  }));
  let ignoredProjectPaths = workspace.value.ignoredProjectPaths ?? [];

  if (deleteFolder) {
    const stats = await Neutralino.filesystem.getStats(projectPath);
    if (!stats.isDirectory)
      throw new Error("Selected project must be a folder.");
    await Neutralino.filesystem.remove(projectPath);
    ignoredProjectPaths = ignoredProjectPaths.filter(
      (path) => path !== projectPath,
    );
  } else if (!ignoredProjectPaths.includes(projectPath)) {
    ignoredProjectPaths = [...ignoredProjectPaths, projectPath];
  }

  await writeHubData(workspace.value.rootPath, groups, ignoredProjectPaths);
};

const addNativeProjectToGroup = async (
  projectPath: string,
  groupId: string,
) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  const stats = await Neutralino.filesystem.getStats(projectPath);
  if (!stats.isDirectory) throw new Error("Selected project must be a folder.");
  const ignoredProjectPaths = (
    workspace.value.ignoredProjectPaths ?? []
  ).filter((path) => path !== projectPath);

  const groups = workspace.value.groups.map((group) =>
    group.id === groupId && !group.projectPaths.includes(projectPath)
      ? { ...group, projectPaths: [...group.projectPaths, projectPath] }
      : group,
  );

  await writeHubData(workspace.value.rootPath, groups, ignoredProjectPaths);
};

const moveNativeProjectsToGroup = async (
  projectPaths: string[],
  groupId: string,
) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  const targetGroup = workspace.value.groups.find(
    (group) => group.id === groupId,
  );
  if (!targetGroup) throw new Error("Group not found.");

  const targetWorkspacePath =
    targetGroup.workspacePath ||
    (await getDefaultGroupWorkspacePath(targetGroup.name));
  try {
    await Neutralino.filesystem.createDirectory(targetWorkspacePath);
  } catch {
    const stats = await Neutralino.filesystem.getStats(targetWorkspacePath);
    if (!stats.isDirectory)
      throw new Error("Target group workspace must be a folder.");
  }

  const movedPathByOriginal = new Map<string, string>();

  for (const projectPath of projectPaths) {
    const projectFolderName = projectPath.split(/[\\/]/).pop() || projectPath;
    const nextProjectPath = await joinPath(
      targetWorkspacePath,
      projectFolderName,
    );

    if (nextProjectPath !== projectPath) {
      await assertNativePathMissing(nextProjectPath, projectFolderName);
    }

    movedPathByOriginal.set(projectPath, nextProjectPath);
  }

  for (const projectPath of projectPaths) {
    const nextProjectPath = movedPathByOriginal.get(projectPath) ?? projectPath;
    await moveNativeProjectFolder(projectPath, nextProjectPath);
  }

  const moving = new Set(projectPaths);
  const groups = workspace.value.groups.map((group) => {
    const remaining = group.projectPaths.filter(
      (projectPath) => !moving.has(projectPath),
    );
    const movedPaths = projectPaths.map(
      (projectPath) => movedPathByOriginal.get(projectPath) ?? projectPath,
    );

    return group.id === groupId
      ? {
          ...group,
          workspacePath: targetWorkspacePath,
          projectPaths: Array.from(new Set([...remaining, ...movedPaths])),
        }
      : { ...group, projectPaths: remaining };
  });

  await writeHubData(
    workspace.value.rootPath,
    groups,
    workspace.value.ignoredProjectPaths,
  );
};

const setStatus = (message: string) => {
  statusMessage.value = message;
  window.setTimeout(() => {
    if (statusMessage.value === message) statusMessage.value = "";
  }, 3200);
};

const selectDashboard = () => {
  // Dashboard is the only primary view now.
};

const normalizeActiveSelection = (data: Workspace) => {
  if (
    activeGroupId.value !== ALL_PROJECTS_ID &&
    !data.groups.some((group) => group.id === activeGroupId.value)
  ) {
    activeGroupId.value = ALL_PROJECTS_ID;
  }

  if (
    !projectGroupId.value ||
    !data.groups.some((group) => group.id === projectGroupId.value)
  ) {
    projectGroupId.value = data.groups[0]?.id ?? "";
  }

  if (
    !targetGroupId.value ||
    !data.groups.some((group) => group.id === targetGroupId.value)
  ) {
    targetGroupId.value = data.groups[0]?.id ?? "";
  }

  const availablePaths = new Set(data.projects.map((project) => project.path));
  selectedProjectPaths.value = new Set(
    [...selectedProjectPaths.value].filter((projectPath) =>
      availablePaths.has(projectPath),
    ),
  );
};

const refreshWorkspace = async () => {
  if (!rootPath.value.trim()) {
    workspace.value = null;
    return;
  }

  isLoading.value = true;
  errorMessage.value = "";

  try {
    const data = isNeutralino()
      ? await getNativeWorkspace(rootPath.value.trim())
      : await request<Workspace>("/api/workspace", {
          rootPath: rootPath.value.trim(),
        });
    workspace.value = data;
    rootPath.value = data.rootPath;
    normalizeActiveSelection(data);
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to load workspace.");
  } finally {
    isLoading.value = false;
  }
};

const pickProjectFolder = async () => chooseFolder("project");

const pickGroupWorkspaceFolder = async () => chooseFolder("group");

const pickRenameGroupWorkspaceFolder = async () => chooseFolder("rename");

const createGroup = async () => {
  if (!workspace.value || !groupName.value.trim()) return;

  isLoading.value = true;
  errorMessage.value = "";

  try {
    const group = isNeutralino()
      ? await createNativeGroup(groupName.value, groupWorkspacePath.value)
      : await request<Group>("/api/groups", {
          rootPath: workspace.value.rootPath,
          name: groupName.value,
          workspacePath: groupWorkspacePath.value,
        });
    groupName.value = "";
    groupWorkspacePath.value = "";
    showCreateGroupPanel.value = false;
    await refreshWorkspace();
    activeGroupId.value = group.id;
    projectGroupId.value = group.id;
    setStatus("Group created.");
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to create group.");
  } finally {
    isLoading.value = false;
  }
};

const openCreateGroupPanel = () => {
  if (!hasWorkspace.value) return;

  groupName.value = "";
  groupWorkspacePath.value = "";
  showCreateGroupPanel.value = true;
};

const closeCreateGroupPanel = () => {
  showCreateGroupPanel.value = false;
  groupName.value = "";
  groupWorkspacePath.value = "";
};

const openRenameGroupPanel = (groupId = activeGroupId.value) => {
  if (!workspace.value || groupId === ALL_PROJECTS_ID) return;

  const group = workspace.value.groups.find((item) => item.id === groupId);
  if (!group) return;

  groupToRenameId.value = group.id;
  renameGroupName.value = group.name;
  renameGroupWorkspacePath.value = group.workspacePath || "";
  showRenameGroupPanel.value = true;
};

const closeRenameGroupPanel = () => {
  showRenameGroupPanel.value = false;
  groupToRenameId.value = "";
  renameGroupName.value = "";
  renameGroupWorkspacePath.value = "";
};

const renameGroup = async () => {
  if (
    !workspace.value ||
    !groupToRenameId.value ||
    !renameGroupName.value.trim()
  )
    return;

  isLoading.value = true;
  errorMessage.value = "";

  try {
    const groupId = groupToRenameId.value;

    if (isNeutralino()) {
      await renameNativeGroup(
        groupId,
        renameGroupName.value,
        renameGroupWorkspacePath.value,
      );
    } else {
      await request("/api/groups/rename", {
        rootPath: workspace.value.rootPath,
        groupId,
        name: renameGroupName.value,
        workspacePath: renameGroupWorkspacePath.value,
      });
    }

    closeRenameGroupPanel();
    await refreshWorkspace();
    activeGroupId.value = groupId;
    setStatus("Group renamed.");
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to rename group.");
  } finally {
    isLoading.value = false;
  }
};

const deleteGroup = async (groupId = activeGroupId.value) => {
  if (!workspace.value || groupId === ALL_PROJECTS_ID) return;

  const group = workspace.value.groups.find((item) => item.id === groupId);
  if (!group) return;

  const confirmed = await confirmAction(
    `Delete "${group.name}"? Projects will stay on disk.`,
  );
  if (!confirmed) return;

  isLoading.value = true;
  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      await deleteNativeGroup(group.id);
    } else {
      await request("/api/groups/delete", {
        rootPath: workspace.value.rootPath,
        groupId: group.id,
      });
    }

    if (activeGroupId.value === group.id) activeGroupId.value = ALL_PROJECTS_ID;
    if (projectGroupId.value === group.id) projectGroupId.value = "";
    if (targetGroupId.value === group.id) targetGroupId.value = "";
    await refreshWorkspace();
    setStatus("Group deleted. Project folders were kept.");
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to delete group.");
  } finally {
    isLoading.value = false;
  }
};

const reorderGroups = async (sourceGroupId: string, targetGroupId: string) => {
  if (!workspace.value || sourceGroupId === targetGroupId) return;

  const groups = [...workspace.value.groups];
  const sourceIndex = groups.findIndex((group) => group.id === sourceGroupId);
  const targetIndex = groups.findIndex((group) => group.id === targetGroupId);

  if (sourceIndex === -1 || targetIndex === -1) return;

  const [movedGroup] = groups.splice(sourceIndex, 1);
  if (!movedGroup) return;

  groups.splice(targetIndex, 0, movedGroup);
  workspace.value = { ...workspace.value, groups };
  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      await reorderNativeGroups(groups);
    } else {
      await request("/api/groups/reorder", {
        rootPath: workspace.value.rootPath,
        groupIds: groups.map((group) => group.id),
      });
    }

    setStatus("Group order saved.");
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to save group order.");
    await refreshWorkspace();
  }
};

const handleGroupDragStart = (event: DragEvent, groupId: string) => {
  draggedGroupId.value = groupId;
  dragOverGroupId.value = "";
  event.dataTransfer?.setData("text/plain", groupId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
};

const handleGroupDragOver = (event: DragEvent, groupId: string) => {
  event.preventDefault();
  dragOverGroupId.value = groupId;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
};

const handleGroupDrop = async (event: DragEvent, groupId: string) => {
  event.preventDefault();
  const sourceGroupId =
    event.dataTransfer?.getData("text/plain") || draggedGroupId.value;

  draggedGroupId.value = "";
  dragOverGroupId.value = "";
  await reorderGroups(sourceGroupId, groupId);
};

const handleGroupDragEnd = () => {
  draggedGroupId.value = "";
  dragOverGroupId.value = "";
};

const createProject = async () => {
  if (!workspace.value || !projectGroupId.value || !projectName.value.trim())
    return;

  const template = projectTemplate.value;
  isLoading.value = true;
  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      await createNativeProject(
        projectName.value,
        projectGroupId.value,
        projectTemplate.value,
      );
    } else {
      await request<Project>("/api/projects", {
        rootPath: workspace.value.rootPath,
        groupId: projectGroupId.value,
        name: projectName.value,
        template: projectTemplate.value,
      });
    }
    projectName.value = "";
    await refreshWorkspace();
    activeGroupId.value = projectGroupId.value;
    setStatus(
      template === "git"
        ? "Repository cloned and added to the group."
        : "Project folder created in the group workspace.",
    );
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to create project.");
  } finally {
    isLoading.value = false;
  }
};

const deleteProject = async (project: Project) => {
  if (!workspace.value) return;

  const confirmed = await confirmAction(
    `Remove "${project.name}" from Projects Hub?`,
  );
  if (!confirmed) return;

  const deleteFolder = await confirmAction(
    `Also delete this folder from disk?\n\n${project.path}`,
  );

  isLoading.value = true;
  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      await deleteNativeProject(project.path, deleteFolder);
    } else {
      await request("/api/projects/delete", {
        rootPath: workspace.value.rootPath,
        path: project.path,
        deleteFolder,
      });
    }

    selectedProjectPaths.value = new Set(
      [...selectedProjectPaths.value].filter(
        (projectPath) => projectPath !== project.path,
      ),
    );
    await refreshWorkspace();
    setStatus(
      deleteFolder
        ? "Project folder deleted."
        : "Project removed from group metadata.",
    );
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to delete project.");
  } finally {
    isLoading.value = false;
  }
};

const importProject = async () => {
  if (
    !workspace.value ||
    !projectGroupId.value ||
    !importedProjectPath.value.trim()
  )
    return;

  isLoading.value = true;
  errorMessage.value = "";

  try {
    const projectPath = importedProjectPath.value.trim();

    if (isNeutralino()) {
      await addNativeProjectToGroup(projectPath, projectGroupId.value);
    } else {
      await request("/api/groups/add-project", {
        rootPath: workspace.value.rootPath,
        groupId: projectGroupId.value,
        path: projectPath,
      });
    }

    importedProjectPath.value = "";
    browserPickedProjectFolderName.value = "";
    await refreshWorkspace();
    activeGroupId.value = projectGroupId.value;
    setStatus("Project loaded into group.");
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to load project.");
  } finally {
    isLoading.value = false;
  }
};

const toggleProjectSelection = (
  projectPath: string,
  checked?: boolean,
  updateAnchor = true,
) => {
  const next = new Set(selectedProjectPaths.value);
  const shouldSelect = checked ?? !next.has(projectPath);

  if (shouldSelect) next.add(projectPath);
  else next.delete(projectPath);

  selectedProjectPaths.value = next;
  if (updateAnchor) lastSelectedProjectPath.value = projectPath;
};

const selectProjectRange = (projectPath: string, checked?: boolean) => {
  const visiblePaths = selectableFilteredProjectPaths.value;
  const anchorIndex = visiblePaths.indexOf(lastSelectedProjectPath.value);
  const targetIndex = visiblePaths.indexOf(projectPath);

  if (anchorIndex === -1 || targetIndex === -1) {
    toggleProjectSelection(projectPath, checked);
    return;
  }

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  const shouldSelect = checked ?? !selectedProjectPaths.value.has(projectPath);
  const next = new Set(selectedProjectPaths.value);

  for (const path of visiblePaths.slice(start, end + 1)) {
    if (shouldSelect) next.add(path);
    else next.delete(path);
  }

  selectedProjectPaths.value = next;
  lastSelectedProjectPath.value = projectPath;
};

const handleProjectSelectionClick = (
  event: MouseEvent,
  projectPath: string,
) => {
  if (event.shiftKey) {
    selectProjectRange(projectPath);
    return;
  }

  toggleProjectSelection(projectPath);
};

const handleProjectCheckboxClick = (event: MouseEvent, projectPath: string) => {
  const checked = (event.target as HTMLInputElement).checked;

  if (event.shiftKey) {
    selectProjectRange(projectPath, checked);
    return;
  }

  toggleProjectSelection(projectPath, checked);
};

const toggleAllFilteredProjects = (checked: boolean) => {
  const next = new Set(selectedProjectPaths.value);

  for (const projectPath of selectableFilteredProjectPaths.value) {
    if (checked) next.add(projectPath);
    else next.delete(projectPath);
  }

  selectedProjectPaths.value = next;
  lastSelectedProjectPath.value = "";
};

const openGroupPanel = () => {
  if (selectedProjectPaths.value.size === 0) return;

  contextMenu.value = null;
  groupPanelMode.value = "move";
  targetGroupId.value =
    activeGroup.value.id !== ALL_PROJECTS_ID
      ? activeGroup.value.id
      : (workspace.value?.groups[0]?.id ?? "");
};

const closeGroupPanel = () => {
  groupPanelMode.value = null;
};

const inspectSuiteCloudProject = async (projectPath: string) => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  if (isNeutralino()) return inspectNativeSuiteCloudProject(projectPath);

  return request<SuiteCloudProjectInfo>("/api/suitecloud/inspect", {
    rootPath: workspace.value.rootPath,
    path: projectPath,
  });
};

const openProjectContextMenu = (event: MouseEvent, projectPath: string) => {
  event.preventDefault();

  if (!selectedProjectPaths.value.has(projectPath)) {
    selectedProjectPaths.value = new Set([projectPath]);
    lastSelectedProjectPath.value = projectPath;
  }

  const panel = (event.currentTarget as HTMLElement).closest(
    ".workspace-panel",
  ) as HTMLElement;
  const bounds = panel.getBoundingClientRect();
  const scale = bounds.width / panel.offsetWidth;
  contextMenu.value = {
    x: Math.max(
      8,
      Math.min((event.clientX - bounds.left) / scale, panel.clientWidth - 200),
    ),
    y: Math.max(
      8,
      Math.min((event.clientY - bounds.top) / scale, panel.clientHeight - 220),
    ),
    projectPath,
    suiteCloudState: "checking",
  };

  void inspectSuiteCloudProject(projectPath)
    .then((info) => {
      if (contextMenu.value?.projectPath !== projectPath) return;
      contextMenu.value.suiteCloudState = info.isSuiteCloud
        ? "available"
        : "unavailable";
    })
    .catch(() => {
      if (contextMenu.value?.projectPath === projectPath)
        contextMenu.value.suiteCloudState = "unavailable";
    });
};

const closeContextMenu = () => {
  contextMenu.value = null;
};

const copyProjectPath = async (
  projectPath = contextMenu.value?.projectPath,
) => {
  if (!projectPath) return;

  try {
    if (isNeutralino()) {
      await Neutralino.clipboard.writeText(projectPath);
    } else {
      await navigator.clipboard.writeText(projectPath);
    }

    closeContextMenu();
    setStatus("Project path copied.");
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to copy project path.");
  }
};

const openSuiteCloudUpload = async (
  projectPath = contextMenu.value?.projectPath,
) => {
  if (!projectPath) return;

  const project = allProjects.value.find((item) => item.path === projectPath);
  closeContextMenu();
  errorMessage.value = "";

  try {
    const info = await inspectSuiteCloudProject(projectPath);
    if (!info.isSuiteCloud)
      throw new Error(
        "This folder is not an SDF SuiteCloud project with a FileCabinet folder.",
      );

    suiteCloudProject.value = project ?? {
      name: projectPath.split(/[\\/]/).pop() || projectPath,
      path: projectPath,
      modifiedAt: new Date().toISOString(),
    };
    suiteCloudInfo.value = info;
  } catch (error) {
    errorMessage.value = formatError(
      error,
      "Unable to open SuiteCloud file upload.",
    );
  }
};

const closeSuiteCloudUpload = () => {
  if (isSuiteCloudUploading.value) return;
  suiteCloudProject.value = null;
  suiteCloudInfo.value = null;
};

const refreshSuiteCloudInfo = async () => {
  if (!suiteCloudProject.value) return;
  isSuiteCloudRefreshing.value = true;
  errorMessage.value = "";
  try {
    const info = await inspectSuiteCloudProject(suiteCloudProject.value.path);
    if (!info.isSuiteCloud)
      throw new Error(
        "This folder is no longer recognized as an SDF SuiteCloud project.",
      );
    suiteCloudInfo.value = info;
  } catch (error) {
    errorMessage.value = formatError(
      error,
      "Unable to refresh SuiteCloud accounts.",
    );
  } finally {
    isSuiteCloudRefreshing.value = false;
  }
};

const openSuiteCloudBrowserLogin = async () => {
  if (!workspace.value || !suiteCloudProject.value) return;
  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      const targetPath = suiteCloudProject.value.path.replace(/"/g, '\\"');
      const command =
        `cmd.exe /D /C start "SuiteCloud Browser Login" /D "${targetPath}" cmd.exe /D /K ` +
        `"${browserSuiteCloudCommand("suitecloud account:setup")}"`;
      await Neutralino.os.execCommand(command, {
        background: true,
        cwd: suiteCloudProject.value.path,
      });
    } else {
      await request("/api/suitecloud/login", {
        rootPath: workspace.value.rootPath,
        path: suiteCloudProject.value.path,
      });
    }

    setStatus(
      "SuiteCloud browser login opened. Complete it in the terminal, then refresh accounts here.",
    );
  } catch (error) {
    errorMessage.value = formatError(
      error,
      "Unable to open SuiteCloud browser login.",
    );
  }
};

const uploadSuiteCloudFiles = async (paths: string[], account: string) => {
  const project = suiteCloudProject.value;
  const info = suiteCloudInfo.value;
  if (!workspace.value || !project || !info || paths.length === 0 || !account)
    return;

  const availablePaths = new Set(info.files.map((file) => file.cabinetPath));
  if (paths.some((path) => !availablePaths.has(path))) {
    errorMessage.value =
      "One or more selected paths are no longer available in this File Cabinet.";
    return;
  }
  if (!info.accounts.includes(account)) {
    errorMessage.value = "Select a configured SuiteCloud authentication ID.";
    return;
  }

  isSuiteCloudUploading.value = true;
  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      await writeNativeDefaultAuthId(project.path, account);
      await runNativeProjectCommand(
        project.path,
        browserSuiteCloudCommand(
          `suitecloud file:upload --paths ${paths.map(quoteCommandArg).join(" ")}`,
        ),
      );
    } else {
      await request("/api/suitecloud/upload", {
        rootPath: workspace.value.rootPath,
        path: project.path,
        paths,
        account,
      });
    }

    const count = paths.length;
    setStatus(
      `${count} File Cabinet file${count === 1 ? "" : "s"} uploaded using ${account}.`,
    );
  } catch (error) {
    errorMessage.value = formatError(error, "SuiteCloud file upload failed.");
  } finally {
    isSuiteCloudUploading.value = false;
  }
};

const applyGroupPanel = async () => {
  if (
    !workspace.value ||
    !groupPanelMode.value ||
    !targetGroupId.value ||
    selectedProjectPaths.value.size === 0
  )
    return;

  isLoading.value = true;
  errorMessage.value = "";

  try {
    const projectPaths = [...selectedProjectPaths.value];

    if (isNeutralino()) {
      await moveNativeProjectsToGroup(projectPaths, targetGroupId.value);
    } else {
      await request("/api/groups/move-projects", {
        rootPath: workspace.value.rootPath,
        groupId: targetGroupId.value,
        paths: projectPaths,
      });
    }

    const targetGroup = workspace.value.groups.find(
      (group) => group.id === targetGroupId.value,
    );
    const count = selectedProjectPaths.value.size;
    groupPanelMode.value = null;
    await refreshWorkspace();
    activeGroupId.value = targetGroupId.value;
    selectedProjectPaths.value = new Set();
    setStatus(
      `${count} project${count === 1 ? "" : "s"} moved to ${targetGroup?.name ?? "group"}.`,
    );
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to update project group.");
    console.error("Unable to move selected projects.", error);
  } finally {
    isLoading.value = false;
  }
};

const openInCode = async (targetPath: string) => {
  if (!workspace.value) return;

  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      await Neutralino.os.execCommand(
        `code "${targetPath.replace(/"/g, '\\"')}"`,
        { background: true },
      );
    } else {
      await request("/api/open-code", {
        rootPath: workspace.value.rootPath,
        path: targetPath,
      });
    }
    setStatus("Opening in VS Code.");
  } catch (error) {
    errorMessage.value = `${formatError(error, "Unable to open VS Code.")}. Make sure the VS Code "code" command is available in PATH.`;
  }
};

const runTerminalCommand = async (
  cwd: string,
  command: string,
): Promise<TerminalCommandResult> => {
  if (!workspace.value) throw new Error("Workspace not loaded.");

  if (isNeutralino()) {
    const result = await Neutralino.os.execCommand(command, { cwd });
    return {
      stdOut: result.stdOut ?? "",
      stdErr: result.stdErr ?? "",
      exitCode: result.exitCode ?? 0,
    };
  }

  return request<TerminalCommandResult>("/api/terminal/run", {
    rootPath: workspace.value.rootPath,
    path: cwd,
    command,
  });
};

const handleTerminalStateChange = async (state: TerminalState) => {
  if (!workspace.value) return;

  const terminalState = normalizeTerminalState(state);
  workspace.value = { ...workspace.value, terminalState };

  try {
    if (isNeutralino()) {
      await writeHubData(
        workspace.value.rootPath,
        workspace.value.groups,
        workspace.value.ignoredProjectPaths,
        terminalState,
      );
    } else {
      await request("/api/terminal/state", {
        rootPath: workspace.value.rootPath,
        terminalState,
      });
    }
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to save terminal tabs.");
  }
};

const openInTerminal = async (targetPath = contextMenu.value?.projectPath) => {
  if (!targetPath) return;

  closeContextMenu();
  await terminalPanel.value?.addTab(
    targetPath,
    targetPath.split(/[\\/]/).pop() || targetPath,
  );
  setStatus("Terminal tab opened.");
};

const openInExplorer = async (targetPath = contextMenu.value?.projectPath) => {
  if (!workspace.value || !targetPath) return;

  errorMessage.value = "";

  try {
    if (isNeutralino()) {
      await Neutralino.os.execCommand(
        `cmd.exe /C start "" "${targetPath.replace(/"/g, '\\"')}"`,
        { background: true },
      );
    } else {
      await request("/api/open-explorer", {
        rootPath: workspace.value.rootPath,
        path: targetPath,
      });
    }

    closeContextMenu();
    setStatus("Opening in Explorer.");
  } catch (error) {
    errorMessage.value = formatError(error, "Unable to open Explorer.");
  }
};
const formatDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

const initializeWorkspace = async () => {
  const savedRootPath = await readSavedRootPath();

  rootPath.value = savedRootPath;

  await refreshWorkspace();
};

function hubWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey)) event.stopPropagation();
}
const confirmation = ref<{
  message: string;
  resolve: (value: boolean) => void;
}>();
function confirmAction(message: string) {
  return new Promise<boolean>((resolve) => {
    confirmation.value = { message, resolve };
  });
}
function answerConfirmation(value: boolean) {
  confirmation.value?.resolve(value);
  confirmation.value = undefined;
}
onBeforeUnmount(() => answerConfirmation(false));
const folderPicker = ref(""),
  folderPath = ref(""),
  folderParent = ref(""),
  folderError = ref("");
const folderItems = ref<{ name: string; path: string }[]>([]);
async function browseFolder(path?: string) {
  try {
    folderError.value = "";
    const data = await request<{
      path: string;
      parent: string | null;
      folders: { name: string; path: string }[];
    }>("/api/folders", path ? { path } : {});
    folderPath.value = data.path;
    folderParent.value = data.parent || "";
    folderItems.value = data.folders;
  } catch (error) {
    folderError.value = formatError(error, "Unable to browse folder.");
  }
}
function chooseFolder(field: string) {
  folderPicker.value = field;
  void browseFolder(rootPath.value || undefined);
}
function acceptFolder() {
  if (folderPicker.value === "root") rootPath.value = folderPath.value;
  if (folderPicker.value === "project")
    importedProjectPath.value = folderPath.value;
  if (folderPicker.value === "group")
    groupWorkspacePath.value = folderPath.value;
  if (folderPicker.value === "rename")
    renameGroupWorkspacePath.value = folderPath.value;
  folderPicker.value = "";
}
async function loadRoot() {
  await refreshWorkspace();
  if (workspace.value) props.block.value = workspace.value.rootPath;
}
watch(
  () => props.block.value,
  (value) => {
    if (value !== rootPath.value) {
      rootPath.value = value;
      void refreshWorkspace();
    }
  },
);

onMounted(initializeWorkspace);
</script>

<template>
  <main
    class="app-shell projects-hub"
    aria-label="Projects Hub"
    @keydown.stop
    @wheel="hubWheel"
  >
    <div v-if="confirmation" class="modal-backdrop">
      <section class="modal">
        <h3>Confirm action</h3>
        <p>{{ confirmation.message }}</p>
        <div class="modal-actions">
          <button class="button secondary" @click="answerConfirmation(false)">
            Cancel</button
          ><button class="button" @click="answerConfirmation(true)">
            Continue
          </button>
        </div>
      </section>
    </div>
    <div v-if="folderPicker" class="modal-backdrop">
      <section class="modal">
        <h3>Choose a folder</h3>
        <form class="hub-path-form" @submit.prevent="browseFolder(folderPath)">
          <input
            v-model="folderPath"
            aria-label="Browse folder path"
            placeholder="Absolute folder path"
          /><button class="button secondary">Go</button>
        </form>
        <p v-if="folderError" role="alert">{{ folderError }}</p>
        <div class="hub-folder-list">
          <button
            v-if="folderParent"
            class="button secondary"
            @click="browseFolder(folderParent)"
          >
            Parent folder</button
          ><button
            v-for="item in folderItems"
            :key="item.path"
            class="hub-folder-row"
            @click="browseFolder(item.path)"
          >
            <Folder :size="14" />{{ item.name }}
          </button>
        </div>
        <div class="modal-actions">
          <button class="button secondary" @click="folderPicker = ''">
            Cancel</button
          ><button class="button" @click="acceptFolder">Use this folder</button>
        </div>
      </section>
    </div>
    <aside class="sidebar">
      <div class="brand-row">
        <div class="brand-mark">
          <Folder :size="20" aria-hidden="true" />
        </div>
        <div>
          <h1>Projects Hub</h1>
          <p>{{ totalProjects }} projects</p>
        </div>
      </div>

      <form class="hub-root-form" @submit.prevent="loadRoot">
        <label
          >Projects folder<input
            v-model="rootPath"
            aria-label="Projects root folder"
            placeholder="Choose a local folder"
        /></label>
        <div>
          <button
            type="button"
            class="button secondary"
            @click="chooseFolder('root')"
          >
            Browse</button
          ><button class="button" :disabled="!rootPath.trim() || isLoading">
            Open
          </button>
        </div>
      </form>
      <section class="sidebar-section grow">
        <div class="section-title">
          <span>Groups</span>
          <div class="section-actions">
            <button
              class="icon-button"
              aria-label="Create group"
              :disabled="!hasWorkspace || isLoading"
              @click="openCreateGroupPanel"
            >
              <Plus aria-hidden="true" />
            </button>
            <button
              class="icon-button"
              aria-label="Refresh"
              :disabled="isLoading"
              @click="refreshWorkspace"
            >
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </div>
        <div class="group-list">
          <button
            class="group-item"
            :class="{ active: activeGroupId === ALL_PROJECTS_ID }"
            @click="
              activeGroupId = ALL_PROJECTS_ID;
              selectDashboard();
            "
          >
            <Folder class="folder-icon" aria-hidden="true" />
            <span class="group-name">All Projects</span>
            <span class="count-pill">{{ totalProjects }}</span>
          </button>
          <div
            v-for="group in workspace?.groups"
            :key="group.id"
            class="group-row"
            :class="{
              active: group.id === activeGroupId,
              dragging: group.id === draggedGroupId,
              'drag-over':
                group.id === dragOverGroupId && group.id !== draggedGroupId,
            }"
            draggable="true"
            @dragstart="handleGroupDragStart($event, group.id)"
            @dragover="handleGroupDragOver($event, group.id)"
            @dragleave="
              dragOverGroupId =
                dragOverGroupId === group.id ? '' : dragOverGroupId
            "
            @drop="handleGroupDrop($event, group.id)"
            @dragend="handleGroupDragEnd"
          >
            <button
              class="group-item"
              @click="
                activeGroupId = group.id;
                selectDashboard();
              "
            >
              <Folder class="folder-icon" aria-hidden="true" />
              <span class="group-name">{{ group.name }}</span>
              <span class="count-pill">{{ group.projects.length }}</span>
            </button>
            <div class="group-row-actions">
              <button
                class="icon-button"
                aria-label="Rename group"
                :disabled="isLoading"
                @click="openRenameGroupPanel(group.id)"
              >
                <Edit3 aria-hidden="true" />
              </button>
              <button
                class="icon-button danger"
                aria-label="Delete group"
                :disabled="isLoading"
                @click="deleteGroup(group.id)"
              >
                <Trash2 aria-hidden="true" />
              </button>
            </div>
          </div>
          <div
            v-if="hasWorkspace && workspace?.groups.length === 0"
            class="empty-note"
          >
            No groups yet.
          </div>
        </div>
      </section>
    </aside>

    <section class="workspace-panel">
      <template v-if="hasWorkspace">
        <div class="toolbar">
          <div class="breadcrumb">
            <button
              aria-label="All projects"
              @click="activeGroupId = ALL_PROJECTS_ID"
            >
              <Home aria-hidden="true" />
            </button>
            <span>/</span>
            <strong>{{ activeGroup.name }}</strong>
          </div>
          <div class="toolbar-actions">
            <template v-if="selectedProjectPaths.size > 0">
              <span class="selection-count"
                >{{ selectedProjectPaths.size }} selected</span
              >
              <button
                class="button secondary"
                :disabled="workspace?.groups.length === 0"
                @click="openGroupPanel"
              >
                Move
              </button>
            </template>
            <div class="search-box">
              <Search aria-hidden="true" />
              <input
                v-model="searchQuery"
                type="search"
                placeholder="Filter projects..."
              />
            </div>
            <button
              class="icon-button"
              aria-label="Refresh"
              :disabled="isLoading"
              @click="refreshWorkspace"
            >
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
        </div>

        <div class="create-strip">
          <div class="create-actions">
            <form class="create-project-form" @submit.prevent="createProject">
              <BaseSelect
                v-model="projectGroupId"
                :options="projectGroupOptions"
                placeholder="Select group"
              />
              <BaseSelect
                v-model="projectTemplate"
                :options="projectTemplateOptions"
                placeholder="Type"
              />
              <input
                v-model="projectName"
                type="text"
                :placeholder="projectNamePlaceholder"
                :aria-label="projectNamePlaceholder"
                autocomplete="off"
              />
              <button
                class="button primary"
                :disabled="isLoading || !projectName.trim() || !projectGroupId"
              >
                Create Project
              </button>
            </form>
            <form class="import-project-form" @submit.prevent="importProject">
              <input
                v-model="importedProjectPath"
                type="text"
                placeholder="Load existing project path"
                autocomplete="off"
              />
              <button
                class="button secondary"
                type="button"
                :disabled="isPickingFolder"
                @click="pickProjectFolder"
              >
                {{ isPickingFolder ? "Choosing..." : "Browse" }}
              </button>
              <button
                class="button secondary"
                :disabled="
                  isLoading || !importedProjectPath.trim() || !projectGroupId
                "
              >
                Load
              </button>
            </form>
            <p v-if="browserPickedProjectFolderName" class="form-hint">
              Browser selected: {{ browserPickedProjectFolderName }}
            </p>
          </div>
        </div>

        <div
          v-if="searchQuery && groupedSearchResults.length > 0"
          class="search-results"
        >
          <div
            v-for="group in groupedSearchResults"
            :key="group.id"
            class="search-group"
          >
            <div class="search-group-title">{{ group.name }}</div>
            <button
              v-for="project in group.projects"
              :key="project.path"
              class="search-result"
              @click="activeGroupId = group.id"
              @dblclick="openInCode(project.path)"
            >
              <FolderGit2 class="project-icon" aria-hidden="true" />
              <strong>{{ project.name }}</strong>
              <small>{{ project.path }}</small>
            </button>
          </div>
        </div>

        <div class="content-grid">
          <section class="project-table">
            <div class="table-head">
              <label class="check-cell" aria-label="Select visible projects">
                <input
                  type="checkbox"
                  :checked="allFilteredProjectsSelected"
                  @change="
                    toggleAllFilteredProjects(
                      ($event.target as HTMLInputElement).checked,
                    )
                  "
                />
              </label>
              <span>Name</span>
              <span>Modified</span>
              <span>Path</span>
              <span></span>
            </div>
            <div class="project-rows" aria-label="Project folders">
              <button
                v-for="project in filteredProjects"
                :key="project.path"
                class="project-row"
                @dblclick="openInCode(project.path)"
                @contextmenu="openProjectContextMenu($event, project.path)"
              >
                <span class="check-cell" @click.stop>
                  <input
                    type="checkbox"
                    :checked="selectedProjectPaths.has(project.path)"
                    @click.stop="
                      handleProjectCheckboxClick($event, project.path)
                    "
                  />
                </span>
                <span
                  class="project-name"
                  @click="handleProjectSelectionClick($event, project.path)"
                >
                  <FolderGit2 class="project-icon" aria-hidden="true" />{{
                    project.name
                  }}
                </span>
                <span>{{ formatDate(project.modifiedAt) }}</span>
                <span class="path-cell">{{ project.path }}</span>
                <span class="row-actions">
                  <button
                    class="mini-button"
                    aria-label="Open in VS Code"
                    @click.stop="openInCode(project.path)"
                  >
                    <Code2 aria-hidden="true" />
                  </button>
                  <button
                    class="mini-button danger"
                    aria-label="Delete project"
                    :disabled="isLoading"
                    @click.stop="deleteProject(project)"
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </span>
              </button>
              <div v-if="filteredProjects.length === 0" class="empty-state">
                <Square aria-hidden="true" />
                <strong>{{
                  activeGroup.id === ALL_PROJECTS_ID
                    ? "No project folders in this root"
                    : "No projects in this group"
                }}</strong>
              </div>
            </div>
          </section>

          <aside class="detail-panel">
            <div class="detail-header">
              <Folder class="folder-icon" aria-hidden="true" />
              <h3>{{ activeGroup.name }}</h3>
              <template v-if="activeGroup.id !== ALL_PROJECTS_ID">
                <button
                  class="icon-button"
                  aria-label="Rename group"
                  :disabled="isLoading"
                  @click="openRenameGroupPanel()"
                >
                  <Edit3 aria-hidden="true" />
                </button>
                <button
                  class="icon-button danger"
                  aria-label="Delete group"
                  :disabled="isLoading"
                  @click="deleteGroup()"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </template>
            </div>
            <dl>
              <dt>Type</dt>
              <dd>
                {{
                  activeGroup.id === ALL_PROJECTS_ID
                    ? "Project folder view"
                    : "Logical group"
                }}
              </dd>
              <dt>Projects</dt>
              <dd>{{ activeGroup.projects.length }}</dd>
              <template v-if="activeGroup.id !== ALL_PROJECTS_ID">
                <dt>Workspace</dt>
                <dd>{{ activeGroup.workspacePath }}</dd>
              </template>
            </dl>
          </aside>
        </div>

        <TerminalPanel
          ref="terminalPanel"
          :initial-cwd="workspace?.rootPath ?? ''"
          :run-command="runTerminalCommand"
          :state="workspace?.terminalState"
          @state-change="handleTerminalStateChange"
        />

        <SuiteCloudUploadView
          v-if="suiteCloudProject && suiteCloudInfo"
          :project-name="suiteCloudProject.name"
          :info="suiteCloudInfo"
          :is-uploading="isSuiteCloudUploading"
          :is-refreshing="isSuiteCloudRefreshing"
          @close="closeSuiteCloudUpload"
          @login="openSuiteCloudBrowserLogin"
          @refresh="refreshSuiteCloudInfo"
          @upload="uploadSuiteCloudFiles"
        />
      </template>

      <div v-else class="empty-state">
        <Square aria-hidden="true" />
        <strong>{{
          isLoading ? "Loading projects" : "Choose a projects folder to begin"
        }}</strong>
      </div>

      <GroupActionModal
        v-if="groupPanelMode"
        :mode="groupPanelMode"
        :groups="workspace?.groups ?? []"
        :selected-projects="selectedProjects"
        :target-group-id="targetGroupId"
        :is-loading="isLoading"
        @target-change="targetGroupId = $event"
        @close="closeGroupPanel"
        @apply="applyGroupPanel"
      />

      <div
        v-if="showCreateGroupPanel"
        class="modal-backdrop"
        @click.self="closeCreateGroupPanel"
      >
        <section class="group-action-panel create-group-panel">
          <div class="detail-header">
            <Folder class="folder-icon" aria-hidden="true" />
            <h3>New Group</h3>
            <button
              class="icon-button"
              aria-label="Close"
              @click="closeCreateGroupPanel"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <form class="group-action-body" @submit.prevent="createGroup">
            <label for="modal-group-name">Group name</label>
            <input
              id="modal-group-name"
              v-model="groupName"
              type="text"
              placeholder="Client Apps"
              autocomplete="off"
            />
            <label for="modal-group-workspace">Workspace folder</label>
            <div class="input-row">
              <input
                id="modal-group-workspace"
                v-model="groupWorkspacePath"
                type="text"
                placeholder="Defaults to root\group name"
                autocomplete="off"
              />
              <button
                class="button secondary"
                type="button"
                :disabled="isPickingFolder"
                @click="pickGroupWorkspaceFolder"
              >
                Browse
              </button>
            </div>
            <button
              class="button primary full"
              :disabled="isLoading || !groupName.trim()"
            >
              {{ isLoading ? "Creating..." : "Create Group" }}
            </button>
          </form>
        </section>
      </div>

      <div
        v-if="showRenameGroupPanel"
        class="modal-backdrop"
        @click.self="closeRenameGroupPanel"
      >
        <section class="group-action-panel create-group-panel">
          <div class="detail-header">
            <Edit3 class="folder-icon" aria-hidden="true" />
            <h3>Rename Group</h3>
            <button
              class="icon-button"
              aria-label="Close"
              @click="closeRenameGroupPanel"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <form class="group-action-body" @submit.prevent="renameGroup">
            <label for="modal-rename-group-name">Group name</label>
            <input
              id="modal-rename-group-name"
              v-model="renameGroupName"
              type="text"
              placeholder="Client Apps"
              autocomplete="off"
            />
            <label for="modal-rename-group-workspace">Workspace folder</label>
            <div class="input-row">
              <input
                id="modal-rename-group-workspace"
                v-model="renameGroupWorkspacePath"
                type="text"
                placeholder="Defaults to root\group name"
                autocomplete="off"
              />
              <button
                class="button secondary"
                type="button"
                :disabled="isPickingFolder"
                @click="pickRenameGroupWorkspaceFolder"
              >
                Browse
              </button>
            </div>
            <button
              class="button primary full"
              :disabled="isLoading || !renameGroupName.trim()"
            >
              <Check aria-hidden="true" />
              {{ isLoading ? "Saving..." : "Save Name" }}
            </button>
          </form>
        </section>
      </div>

      <div
        v-if="contextMenu"
        class="context-backdrop"
        @click="closeContextMenu"
        @contextmenu.prevent="closeContextMenu"
      ></div>
      <div
        v-if="contextMenu"
        class="project-context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      >
        <button
          :disabled="workspace?.groups.length === 0"
          @click="openGroupPanel"
        >
          Move selected to group
        </button>
        <button @click="openInTerminal()">
          <TerminalIcon aria-hidden="true" />
          Open in terminal
        </button>
        <button @click="openInExplorer()">
          <FolderOpen aria-hidden="true" />
          Open in Explorer
        </button>
        <button v-if="contextMenu.suiteCloudState === 'checking'" disabled>
          <CloudUpload aria-hidden="true" />
          Checking SuiteCloud project...
        </button>
        <button
          v-else-if="contextMenu.suiteCloudState === 'available'"
          @click="openSuiteCloudUpload()"
        >
          <CloudUpload aria-hidden="true" />
          Upload File Cabinet files
        </button>
        <button @click="copyProjectPath()">Copy path</button>
      </div>

      <div v-if="statusMessage" class="toast success">{{ statusMessage }}</div>
      <div v-if="errorMessage" class="toast error">{{ errorMessage }}</div>
    </section>
  </main>
</template>
