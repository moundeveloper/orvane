import { accountKey, isNetSuitePage, netSuiteLogin } from "./netsuite-login.mjs";

// Port of Magic NetSuite's FETCH_ACCOUNTS action. It reads the JSON embedded
// in the signed-in role selector, without executing any of its HTML.
function readRoleSelector(html) {
  const fields = (record) => Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key.trim(), value]));
  const findContainer = (record) => {
    if (!record || typeof record !== "object") return;
    const normalized = fields(record);
    if (Array.isArray(normalized.allAccounts)) return normalized;
    for (const child of Object.values(record)) {
      const found = findContainer(child);
      if (found) return found;
    }
  };
  for (const [, script] of html.matchAll(/<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!script.includes("allAccounts")) continue;
    let data;
    try { data = JSON.parse(script); } catch { continue; }
    const result = findContainer(data);
    if (!result) continue;
    return {
      accounts: [result.account, ...result.allAccounts].filter(Boolean).map(fields).map(
        ({ accountId, accountName, accountType }) => ({ accountId, accountName, accountType }),
      ),
      roles: (Array.isArray(result.allRoles) ? result.allRoles : []).map(fields).map(
        ({ entityRoleId, roleName }) => ({ id: fields(entityRoleId).rol, name: roleName }),
      ),
    };
  }
  throw Error("The signed-in NetSuite role selector did not contain any accounts.");
}

export async function browserEnvironments(partition, url) {
  if (!isNetSuitePage(url) || netSuiteLogin(url) || new URL(url).hostname === "system.netsuite.com")
    throw Error("Sign in to this NetSuite tab to list other environments.");
  const { origin } = new URL(url);
  // Use the Browser's authenticated network session directly. Processing
  // pages can stay busy or wait indefinitely for dashboard portlets.
  const signal = AbortSignal.timeout(8000);
  let html;
  try {
    const response = await partition.fetch(`${origin}/app/login/secure/myroles/myroles.nl?whence=`, {
      credentials: "include",
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "text/html" },
      signal,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) ||
        response.status === 401 || response.status === 403)
      throw Error("Sign in to this NetSuite tab to list other environments.");
    if (!response.ok) throw Error(`NetSuite returned HTTP ${response.status}.`);
    html = await response.text();
  } catch (error) {
    if (signal.aborted) throw Error("NetSuite took too long to respond.");
    throw error;
  }
  const entries = accountEnvironments(readRoleSelector(html), origin);
  if (!entries.size) throw Error("The NetSuite role selector returned no environments.");
  return [...entries].map(([origin, environment]) => ({ origin, ...environment }));
}

export function accountEnvironments(data, currentOrigin) {
  const environments = new Map();
  for (const account of Array.isArray(data?.accounts) ? data.accounts : []) {
    const accountId = accountKey(account?.accountId);
    if (!accountId) continue;
    const origin = `https://${accountId}.app.netsuite.com`;
    if (environments.has(origin)) continue;
    const name = typeof account.accountName === "string" ? account.accountName.trim().slice(0, 120) : "";
    const type = typeof account.accountType === "string" ? account.accountType.trim().slice(0, 40) : "";
    const roles = origin === currentOrigin && Array.isArray(data.roles)
      ? data.roles.filter(role => typeof role?.name === "string").map(({ id, name }) => ({ id, name: name.trim().slice(0, 120) }))
      : [];
    environments.set(origin, { accountId, name, type, roles, label: name ? `${name} (${accountId})` : accountId });
  }
  return environments;
}
