import { flatten, type Workspace } from "../src/model.ts";

/** What an agent needs to build workflows and button flows without guessing
 * the node format. Kept next to the runtime in src/App.vue (executeRules). */
export const nodeKinds = [
  {
    action: "set-text",
    does: "Write value into a component: a text field's value, or a text/button label.",
    fields: { appId: "app that owns the component", target: "component ID", value: "text; may use {field} or {input}" },
  },
  {
    action: "add-item",
    does: "Append value as a new item to a list component.",
    fields: { appId: "app", target: "list component ID", value: "item text (blank = previous step's result)" },
  },
  {
    action: "increment",
    does: "Add a number to a counter component.",
    fields: { appId: "app", target: "counter component ID", value: 'amount, default "1"' },
  },
  {
    action: "toggle",
    does: "Flip a checkbox component.",
    fields: { appId: "app", target: "checkbox component ID" },
  },
  {
    action: "clear",
    does: "Empty a text field.",
    fields: { appId: "app", target: "text field component ID" },
  },
  {
    action: "read-field",
    does: "Read a component's current value and pass it on as this step's result (counter number, checkbox true/false, list as JSON, text).",
    fields: { appId: "exposed app", target: "component ID" },
  },
  {
    action: "emit",
    does: "Run another component's own actions (like pressing that button), passing value in.",
    fields: { appId: "exposed app", target: "button/field component ID", value: "value passed to it" },
  },
  {
    action: "workspace-action",
    does: "Run another Action-library workflow and continue with its result.",
    fields: { nodeId: "workflow ID", bindings: "object mapping that workflow's input names to values ({field} allowed)" },
  },
  {
    action: "custom",
    does: "Run a reusable node (action_set): sandboxed JavaScript code or a grouped flow. Code receives the previous result and returns the next.",
    fields: { nodeId: "reusable node ID", value: "input passed to it" },
  },
  {
    action: "navigate",
    does: "Bring an app into view on the canvas.",
    fields: { appId: "destination app" },
  },
  {
    action: "open-view",
    does: "Bring an app into view and open its settings or a component's graph editor.",
    fields: { appId: "destination app", view: '"settings" or "graph"', target: "component ID when view is graph" },
  },
  {
    action: "message",
    does: "Show a short notice to the person (also returned by workflow_run).",
    fields: { value: "message text; may use {field} or {input}" },
  },
];

export const catalogRules = [
  "Values: {Label} or {component ID} is replaced with that component's current value; in a workflow {input name} is an input value. A blank value passes the previous step's result along.",
  "Steps that change or read another app need that app exposed (app_update patch {exposed: true}). Navigate and open-view work on any app.",
  'Graph: edges connect "trigger" to the first steps and each step to the next. A node with several incoming edges waits for all of them. on:"failure" edges run only when the source step fails, for recovery; without one a failure stops dependent steps. Completed steps are kept.',
  "workflow_set with steps builds a straight chain for you; use rules + graph only for branches and failure paths.",
  "Wire a workflow to a button with rules_set: one rule {action:\"workspace-action\", nodeId: workflowId, bindings:{input: \"{Field label}\"}, appId:\"\", target:\"\", value:\"\"}.",
  "Test with component_trigger (press the button) or workflow_run. Both need the Orvane window open and report errors without retrying.",
];

export const catalogExample = {
  tool: "workflow_set",
  args: {
    name: "Log a task",
    inputs: ["task"],
    steps: [
      { action: "add-item", appId: "<tasks app ID>", target: "<list ID>", value: "{task}" },
      { action: "increment", appId: "<tasks app ID>", target: "<counter ID>", value: "1" },
      { action: "message", value: "Added {task}" },
    ],
  },
};

/** The things a workflow can point at right now. */
export function catalogTargets(w: Workspace) {
  const live = w.apps.filter((a) => !a.archived && !a.deleted);
  return {
    apps: live.map((a) => ({
      appId: a.id,
      name: a.name,
      exposed: a.exposed,
      components: flatten(a.blocks)
        .filter((b) => ["text", "input", "button", "checkbox", "list", "counter"].includes(b.kind))
        .map((b) => ({ componentId: b.id, kind: b.kind, label: b.label, hasActions: b.rules.length > 0 })),
    })),
    workflows: (w.actions || []).map((a) => ({ workflowId: a.id, name: a.name, inputs: a.inputs, steps: a.rules.length })),
    reusableNodes: w.customNodes.map((n) => ({ nodeId: n.id, name: n.name, kind: n.rules ? "flow" : "code" })),
  };
}
