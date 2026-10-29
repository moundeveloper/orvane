export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type Project = {
  name: string;
  path: string;
  modifiedAt: string;
};

export type Group = {
  id: string;
  name: string;
  workspacePath?: string;
  projectPaths: string[];
  projects: Project[];
};

export type TerminalState = {
  isOpen?: boolean;
  isMaximized?: boolean;
  height?: number;
  activeCwd?: string;
  tabs?: { title: string; cwd: string }[];
};

export type SuiteCloudFile = {
  name: string;
  cabinetPath: string;
  relativePath: string;
};

export type SuiteCloudProjectInfo = {
  isSuiteCloud: boolean;
  projectPath: string;
  fileCabinetPath?: string;
  files: SuiteCloudFile[];
  accounts: string[];
  defaultAccount?: string;
};
