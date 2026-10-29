import {
  flatten,
  uid,
  type Workspace,
  type Rule,
  type ActionGraph,
} from "./model";

export function mergeWorkspace(
  current: Workspace,
  incoming: Workspace,
): Workspace {
  const copy: Workspace = JSON.parse(JSON.stringify(incoming));
  const ids = new Map<string, string>();
  const remap = (id: string) =>
    id === "trigger" || !id
      ? id
      : ids.get(id) || (ids.set(id, uid()), ids.get(id)!);
  // Map references even when unresolved, so they can never accidentally bind to
  // an unrelated existing app/component/action with the same identifier.
  function flow(rules: Rule[], graph?: ActionGraph) {
    rules.forEach((r) => {
      r.id = remap(r.id);
      r.appId = remap(r.appId);
      r.target = remap(r.target);
      if (r.nodeId) r.nodeId = remap(r.nodeId);
      if (r.flow) flow(r.flow.rules, r.flow.graph);
    });
    if (graph) {
      graph.edges.forEach((e) => {
        e.id = remap(e.id);
        e.source = remap(e.source);
        e.target = remap(e.target);
      });
      graph.positions = Object.fromEntries(
        Object.entries(graph.positions).map(([key, pos]) => [remap(key), pos]),
      );
    }
  }
  copy.apps.forEach((a) => {
    remap(a.id);
    flatten(a.blocks).forEach((b) => remap(b.id));
  });
  copy.customNodes.forEach((n) => remap(n.id));
  copy.actions?.forEach((a) => remap(a.id));
  copy.library.forEach((l) => remap(l.id));
  const allBlocks = [
    ...copy.apps.flatMap((a) => flatten(a.blocks)),
    ...copy.library.flatMap((l) => flatten([l.block])),
  ];
  allBlocks.forEach((b) => {
    b.id = remap(b.id);
    if (b.sharedId) b.sharedId = remap(b.sharedId);
    b.items.forEach((i) => (i.id = uid()));
    flow(b.rules, b.graph);
  });
  copy.apps.forEach((a) => {
    a.id = remap(a.id);
    if (a.groupId) a.groupId = remap(a.groupId);
  });
  copy.customNodes.forEach((n) => {
    n.id = remap(n.id);
    flow(n.rules || [], n.graph);
  });
  copy.actions?.forEach((a) => {
    a.id = remap(a.id);
    flow(a.rules, a.graph);
  });
  copy.library.forEach((l) => (l.id = remap(l.id)));
  copy.groups?.forEach((g) => (g.id = remap(g.id)));
  copy.wheel?.forEach((entry) => {
    entry.id = remap(entry.id);
    entry.parent = remap(entry.parent);
    entry.appId = remap(entry.appId);
    if (entry.actionId) entry.actionId = remap(entry.actionId);
  });
  const values = (rules: Rule[]) =>
    rules.forEach((r) => {
      r.value = r.value.replace(/\{([^}]+)\}/g, (match, key: string) =>
        ids.has(key) ? `{${ids.get(key)}}` : match,
      );
      if (r.bindings)
        for (const key of Object.keys(r.bindings))
          r.bindings[key] = r.bindings[key]!.replace(
            /\{([^}]+)\}/g,
            (match, id: string) => (ids.has(id) ? `{${ids.get(id)}}` : match),
          );
      if (r.flow) values(r.flow.rules);
    });
  allBlocks.forEach((b) => values(b.rules));
  copy.customNodes.forEach((n) => values(n.rules || []));
  copy.actions?.forEach((a) => values(a.rules));
  return {
    ...JSON.parse(JSON.stringify(current)),
    apps: [...current.apps, ...copy.apps],
    library: [...current.library, ...copy.library],
    customNodes: [...current.customNodes, ...copy.customNodes],
    groups: [...(current.groups || []), ...(copy.groups || [])],
    wheel: [...(current.wheel || []), ...(copy.wheel || [])],
    actions: [...(current.actions || []), ...(copy.actions || [])],
  };
}
