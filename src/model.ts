export type Kind =
  | "text"
  | "input"
  | "button"
  | "checkbox"
  | "list"
  | "counter"
  | "divider"
  | "container"
  | "code";
export type ActionKind =
  | "add-item"
  | "clear"
  | "increment"
  | "toggle"
  | "set-text"
  | "emit"
  | "custom";
export interface Rule {
  id: string;
  action: ActionKind;
  target: string;
  appId: string;
  value: string;
  nodeId?: string;
}
export interface ActionGraph {
  edges: { id: string; source: string; target: string }[];
  positions: Record<string, { x: number; y: number }>;
}
export interface Block {
  id: string;
  kind: Kind;
  label: string;
  value: string;
  checked: boolean;
  items: { id: string; text: string; done: boolean }[];
  count: number;
  layout: "column" | "row" | "grid";
  gap: number;
  children: Block[];
  rules: Rule[];
  sharedId?: string;
  code: string;
  height?: number;
  sizing?: "fill" | "fixed";
  graph?: ActionGraph;
}
export interface CanvasApp {
  id: string;
  name: string;
  icon: string;
  x: number;
  y: number;
  width: number;
  height: number;
  blocks: Block[];
  archived: boolean;
  group: string;
  groupId?: string;
  exposed: boolean;
  accent: string;
  padding: number;
  gap: number;
  radius: number;
  showName?: boolean;
  breakpoint?: number;
  editorWidth?: number;
}
export interface CustomNode {
  id: string;
  name: string;
  code: string;
  rules?: Rule[];
  graph?: ActionGraph;
}
export interface Workspace {
  version: 1;
  apps: CanvasApp[];
  library: { id: string; name: string; block: Block }[];
  customNodes: CustomNode[];
  shortcuts: { create: string; search: string; home: string };
  groups?: { id: string; name: string }[];
}
export const uid = () => crypto.randomUUID();
export function validGraph(
  graph: ActionGraph | undefined,
  rules: Rule[],
): boolean {
  if (graph === undefined) return true;
  if (
    !graph ||
    !Array.isArray(graph.edges) ||
    !graph.positions ||
    typeof graph.positions !== "object" ||
    Array.isArray(graph.positions) ||
    graph.edges.length > 20000
  )
    return false;
  const ids = new Set(["trigger", ...rules.map((r) => r.id)]);
  return (
    graph.edges.every(
      (e) =>
        e &&
        typeof e.id === "string" &&
        ids.has(e.source) &&
        ids.has(e.target) &&
        e.target !== "trigger",
    ) &&
    Object.values(graph.positions).every(
      (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y),
    )
  );
}
export const kinds: { kind: Kind; name: string; description: string }[] = [
  { kind: "text", name: "Text", description: "A heading or a few words" },
  {
    kind: "input",
    name: "Text field",
    description: "Collect a thought or a value",
  },
  { kind: "button", name: "Button", description: "Give an action a place" },
  { kind: "checkbox", name: "Checkbox", description: "A simple yes or no" },
  { kind: "list", name: "List", description: "Keep things together" },
  { kind: "counter", name: "Counter", description: "A number you can change" },
  {
    kind: "container",
    name: "Layout",
    description: "Arrange in rows, columns or a grid",
  },
  { kind: "divider", name: "Divider", description: "A quiet separation" },
  {
    kind: "code",
    name: "Custom code",
    description: "Your own HTML, CSS and JavaScript",
  },
];
export function makeBlock(kind: Kind): Block {
  return {
    id: uid(),
    kind,
    label: {
      text: "Something worth keeping.",
      input: "Write something…",
      button: "Add item",
      checkbox: "A small thing to do",
      list: "Your items",
      counter: "Counter",
      container: "Layout",
      divider: "Divider",
      code: "Custom code",
    }[kind],
    value: "",
    checked: false,
    count: 0,
    items: [],
    layout: "column",
    gap: 12,
    children: [],
    rules: [],
    code: "<style>body{font:14px system-ui;color:#455968;padding:12px}button{background:#e7edf0;border:0;padding:8px 12px;color:inherit;border-radius:5px}</style>\n<button onclick=\"this.textContent='Hello, canvas!'\">Make something yours</button>",
  };
}
export function flatten(blocks: Block[]): Block[] {
  return blocks.flatMap((b) => [b, ...flatten(b.children)]);
}
export function emptyWorkspace(): Workspace {
  return {
    version: 1,
    apps: [],
    groups: [],
    library: [],
    customNodes: [],
    shortcuts: { create: "n", search: "k", home: "h" },
  };
}
export function validateWorkspace(data: unknown): data is Workspace {
  if (!data || typeof data !== "object") return false;
  const w = data as Workspace;
  if (
    w.version !== 1 ||
    !Array.isArray(w.apps) ||
    !Array.isArray(w.library) ||
    !Array.isArray(w.customNodes) ||
    !w.shortcuts ||
    (w.groups !== undefined &&
      (!Array.isArray(w.groups) ||
        w.groups.some(
          (g) => !g || typeof g.id !== "string" || typeof g.name !== "string",
        ) ||
        new Set(w.groups.map((g) => g.id)).size !== w.groups.length))
  )
    return false;
  let seen = new Set<string>();
  let count = 0;
  const validBlocks = (blocks: Block[], depth = 0): boolean =>
    depth < 20 &&
    Array.isArray(blocks) &&
    blocks.every((b) => {
      if (
        ++count > 10000 ||
        !b ||
        typeof b.id !== "string" ||
        seen.has(b.id) ||
        !kinds.some((k) => k.kind === b.kind)
      )
        return false;
      seen.add(b.id);
      return (
        typeof b.label === "string" &&
        typeof b.value === "string" &&
        Array.isArray(b.items) &&
        b.items.every(
          (i) => typeof i.text === "string" && typeof i.id === "string",
        ) &&
        Array.isArray(b.rules) &&
        b.rules.every(
          (r) =>
            typeof r.action === "string" &&
            typeof r.target === "string" &&
            typeof r.appId === "string" &&
            typeof r.value === "string",
        ) &&
        Number.isFinite(b.count) &&
        Number.isFinite(b.gap) &&
        typeof b.code === "string" &&
        validGraph(b.graph, b.rules) &&
        validBlocks(b.children, depth + 1)
      );
    });
  return (
    w.apps.length <= 300 &&
    new Set(w.apps.map((a) => a.id)).size === w.apps.length &&
    w.apps.every(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.name === "string" &&
        typeof a.icon === "string" &&
        typeof a.group === "string" &&
        /^#[\da-f]{6}$/i.test(a.accent) &&
        [a.x, a.y, a.width, a.height, a.padding, a.gap, a.radius].every(
          Number.isFinite,
        ) &&
        a.width >= 180 &&
        a.height >= 160 &&
        validBlocks(a.blocks),
    ) &&
    w.library.every((l) => {
      seen = new Set<string>();
      return (
        typeof l.id === "string" &&
        typeof l.name === "string" &&
        validBlocks([l.block])
      );
    }) &&
    w.customNodes.every(
      (n) =>
        typeof n.id === "string" &&
        typeof n.name === "string" &&
        typeof n.code === "string" &&
        (!n.rules || Array.isArray(n.rules)) &&
        validGraph(n.graph, n.rules || []),
    ) &&
    ["create", "search", "home"].every(
      (k) => typeof w.shortcuts[k as keyof typeof w.shortcuts] === "string",
    )
  );
}
