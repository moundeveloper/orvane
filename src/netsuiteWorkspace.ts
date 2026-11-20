// The NetSuite app's calls to server/netsuite-workspace-api.ts (memory,
// SuiteCloud workspace, task runs). Local and same-origin only.

/** NetSuite account ID of an environment origin: https://4027610-sb1.app… → 4027610_SB1. */
export function accountOf(origin: string) {
  try {
    return new URL(origin).hostname.split(".")[0]!.toUpperCase().replace(/-/g, "_");
  } catch {
    return "";
  }
}

export async function workspaceCall<T = any>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/__orvane/netsuite-workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(data?.error || `Request failed (${response.status}).`);
  return data as T;
}

export type SuiteCloudStatus = {
  accountId: string;
  available: boolean;
  cli: string | null;
  authIds: string[];
  authId: string | null;
  reason: string | null;
  created: boolean;
};

/** CLI availability and account authentication, cached briefly. */
const statusCache = new Map<string, { at: number; value: Promise<SuiteCloudStatus> }>();
export function suiteCloudStatus(account: string, refresh = false) {
  const cached = statusCache.get(account);
  if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.value;
  const value = workspaceCall<SuiteCloudStatus>("suitecloud", { account, refresh });
  statusCache.set(account, { at: Date.now(), value });
  value.catch(() => statusCache.delete(account));
  return value;
}
