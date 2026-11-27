// Shared parts of the NetSuite Scripts view (the port of Magic NetSuite's
// scripts list and script page): labels, the request signature and the state
// of deployments started from Orvane, which the table and the side panel
// both show.
import { reactive } from "vue";

export type Row = Record<string, any>;
export type NetSuiteRequest = (
  operation: string,
  args?: Record<string, unknown>,
) => Promise<Row>;

const TYPE_LABELS: Record<string, string> = {
  USEREVENT: "User Event",
  SCRIPTLET: "Suitelet",
  CLIENT: "Client",
  MAPREDUCE: "Map/Reduce",
  SCRIPTED: "Scheduled",
  RESTLET: "RESTlet",
  ACTION: "Workflow Action",
  PORTLET: "Portlet",
  MASSUPDATE: "Mass Update",
  BUNDLEINSTALLATION: "Bundle Installation",
  SDFINSTALLATION: "SDF Installation",
  EMAILCAPTURE: "Email Capture",
  PLUGINTYPEIMPL: "Plug-in",
};
export function typeLabel(type: unknown) {
  const key = String(type ?? "").toUpperCase();
  if (TYPE_LABELS[key]) return TYPE_LABELS[key]!;
  return key ? key[0] + key.slice(1).toLowerCase() : "Script";
}
const STATUS_LABELS: Record<string, string> = {
  RELEASED: "Released",
  TESTING: "Testing",
  SCHEDULED: "Scheduled",
  NOTSCHEDULED: "Not scheduled",
};
export const statusLabel = (status: unknown) =>
  STATUS_LABELS[String(status ?? "").toUpperCase()] ?? String(status ?? "—");
export const levelLabel = (level: unknown) => {
  const value = String(level ?? "").toLowerCase();
  return value ? value[0]!.toUpperCase() + value.slice(1) : "—";
};
export const deployed = (row: Row) =>
  row.isdeployed === true || row.isdeployed === "T";
/** Map/Reduce and Scheduled deployments can be started from Orvane. */
export const runnable = (type: unknown) =>
  ["MAPREDUCE", "SCRIPTED"].includes(String(type ?? "").toUpperCase());
export const suitelet = (type: unknown) =>
  String(type ?? "").toUpperCase() === "SCRIPTLET";
/** Deployments of record-bound scripts say which record they run on. */
export const recordBound = (type: unknown) =>
  ["USEREVENT", "CLIENT"].includes(String(type ?? "").toUpperCase());
export const message = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
    "",
  );
export async function copyText(value: unknown) {
  await navigator.clipboard.writeText(String(value ?? ""));
}

/* ---------- Runs started from Orvane ---------- */

export type RunState = {
  phase: "starting" | "running" | "done" | "failed";
  startedAt: number;
  /** NetSuite's own status (Pending, Processing, Complete, Failed…). */
  status?: string;
  percent?: string;
  stage?: string | null;
  error?: string;
};
/** Keyed by environment|deployment primary key. */
export const runs = reactive(new Map<string, RunState>());
export const runKey = (environment: string, deploymentId: unknown) =>
  `${environment}|${Number(deploymentId)}`;
const FINISHED = /complete|failed|cancel/i;
/** Starts a deployment (NetSuite's Save and Execute) and follows it until
 * NetSuite reports it finished. The state lives in `runs`. */
export async function runDeployment(
  environment: string,
  deploymentId: number,
  request: NetSuiteRequest,
) {
  const key = runKey(environment, deploymentId);
  const current = runs.get(key);
  if (current && (current.phase === "starting" || current.phase === "running"))
    return;
  const state: RunState = { phase: "starting", startedAt: Date.now() };
  runs.set(key, state);
  // run-task sets the deployment to Not Scheduled before Save and Execute;
  // like the MCP task tool, the original status goes back when the run ends.
  let originalStatus = "";
  try {
    const started = await request("run-task", { deploymentId });
    originalStatus = String(started.originalStatus ?? "");
    const submitted = Date.parse(String(started.submittedAt ?? "")) || Date.now();
    runs.set(key, { ...state, phase: "running", status: "Pending" });
    for (let attempt = 0; attempt < 720; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt < 6 ? 2500 : 5000));
      if (runs.get(key)?.startedAt !== state.startedAt) return;
      const data = await request("task-status", { deploymentId }).catch(() => null);
      // The newest instance created after our submit is our run.
      const instance = (data?.instances as Row[] | undefined)?.find(
        (item) => (Date.parse(String(item.created ?? "")) || 0) >= submitted - 60_000,
      );
      if (!instance) continue;
      const status = String(instance.status ?? "");
      const finished = FINISHED.test(status);
      runs.set(key, {
        ...state,
        phase: finished ? (/failed|cancel/i.test(status) ? "failed" : "done") : "running",
        status,
        percent: instance.percent ?? undefined,
        stage: instance.stage ?? null,
      });
      if (finished) {
        await restoreStatus(deploymentId, originalStatus, data?.deployment?.status, request, key);
        return;
      }
    }
  } catch (e) {
    runs.set(key, { ...state, phase: "failed", error: message(e) });
  }
}
/** Puts the deployment's status back unless someone changed it meanwhile. */
async function restoreStatus(
  deploymentId: number,
  original: string,
  current: unknown,
  request: NetSuiteRequest,
  key: string,
) {
  if (!original || original === "NOTSCHEDULED" || String(current ?? "NOTSCHEDULED") !== "NOTSCHEDULED") return;
  try {
    await request("set-deployment-status", { deploymentId, status: original });
  } catch (e) {
    const state = runs.get(key);
    if (state)
      runs.set(key, { ...state, error: `The run ended, but its status could not be set back to ${original}: ${message(e)}` });
  }
}
