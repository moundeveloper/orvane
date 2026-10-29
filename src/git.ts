export interface GitWorkspace {
  id: string;
  name: string;
  path: string;
}
export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}
export interface GitRef {
  hash: string;
  name: string;
  fullName: string;
  kind: "branch" | "remote" | "tag";
}
export interface GitFile {
  path: string;
  status: string;
}
export interface GitHistory {
  mainBranch?: string;
  mainRef?: string;
  mainline?: string[];
  commits: GitCommit[];
  refs: GitRef[];
  head: string;
  branch: string;
  hasMore: boolean;
}
export interface GitCommitDetail {
  hash: string;
  parents: string[];
  message: string;
  files: GitFile[];
}
export interface GitStatus {
  files: { path: string; index: string; worktree: string }[];
}
export interface GitFolder {
  path: string;
  parent: string | null;
  roots: string[];
  folders: { name: string; path: string }[];
}

export async function gitRequest<T>(
  operation: string,
  args: object = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/__orvane/git/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal,
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw Error(result.error || "The repository could not be read.");
  return result as T;
}

// Track outstanding parent hashes as lanes. Parent connections crossing a loaded
// page boundary remain open instead of pretending that history ends there.
export function gitLanes(commits: GitCommit[], mainline = new Set<string>()) {
  let lanes: { hash: string; color: number }[] = [];
  let nextColor = 0;
  return commits.map((commit) => {
    let index = lanes.findIndex((l) => l.hash === commit.hash);
    const continued = index >= 0;
    if (index < 0) {
      index = lanes.length;
      lanes.push({ hash: commit.hash, color: nextColor++ });
    }
    const before = lanes.map((l) => ({ ...l })),
      color = lanes[index]!.color;
    lanes.splice(index, 1);
    commit.parents.forEach((parent, i) => {
      if (!lanes.some((l) => l.hash === parent))
        lanes.splice(Math.min(index + i, lanes.length), 0, {
          hash: parent,
          color: i ? nextColor++ : color,
        });
    });
    const lines: {
      from: number;
      to: number;
      color: number;
      incoming: boolean;
      main: boolean;
    }[] = [];
    before.forEach((lane, from) => {
      if (lane.hash === commit.hash) return;
      const to = lanes.findIndex((l) => l.hash === lane.hash);
      if (to >= 0)
        lines.push({
          from,
          to,
          color: lane.color,
          incoming: false,
          main: mainline.has(lane.hash),
        });
    });
    commit.parents.forEach((parent, parentIndex) => {
      const to = lanes.findIndex((l) => l.hash === parent);
      if (to >= 0)
        lines.push({
          from: index,
          to,
          color: lanes[to]!.color,
          incoming: true,
          main: parentIndex === 0 && mainline.has(commit.hash),
        });
    });
    return {
      index,
      color,
      continued,
      main: mainline.has(commit.hash),
      before: before.length,
      after: lanes.length,
      lines,
    };
  });
}
