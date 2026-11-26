// Claude accounts as the page sees them: one shared, reactive list for the
// composer's Account pill, the locked chips, the launcher, Settings and
// Ctrl+K. The server resolves every ID; nothing here holds folders for runs.
import { reactive } from "vue";
import { agentRequest } from "./exposition";
import type { AgentUsage } from "./agentSessions";

export interface ClaudeAccount {
  id: string;
  name: string;
  color: string;
  folder: string;
  isDefault: boolean;
  inherited: boolean;
  generated: boolean;
  removed: boolean;
  newChats: boolean;
  running: number;
  signingIn: boolean;
  sessions: number;
  mcp: boolean;
  auth: { loggedIn: boolean; supported: boolean; email?: string; plan?: string; error?: string; checkedAt: number } | null;
  usage: AgentUsage | null;
}
interface AccountList {
  profiles: ClaudeAccount[];
  newChatProfileId: string;
  draft: { id: string; folder: string };
}

export const DEFAULT_ACCOUNT = "default";
export const claudeAccounts = reactive({
  list: [] as ClaudeAccount[],
  newChatProfileId: DEFAULT_ACCOUNT,
  draft: null as AccountList["draft"] | null,
  loaded: false,
  error: "",
});

let pending: Promise<void> | undefined;
function apply(data: AccountList) {
  claudeAccounts.list = data.profiles;
  claudeAccounts.newChatProfileId = data.newChatProfileId;
  claudeAccounts.draft = data.draft;
  claudeAccounts.loaded = true;
  claudeAccounts.error = "";
}
/** Reload the list; `check` re-reads every account's sign-in now. */
export function loadAccounts(check = false) {
  if (pending && !check) return pending;
  const request = agentRequest<AccountList>("claude-profiles", check ? { check: true } : {})
    .then(apply)
    .catch((error) => {
      claudeAccounts.error = error instanceof Error ? error.message : "Could not read the Claude accounts.";
    })
    .finally(() => {
      if (pending === request) pending = undefined;
    });
  pending = request;
  return request;
}
/** An account operation; the answer is the fresh list. */
export async function accountAction<T extends object = object>(operation: string, args: Record<string, unknown>) {
  const data = await agentRequest<AccountList & T>(operation, args);
  if (Array.isArray(data.profiles)) apply(data);
  return data;
}
export function accountById(id: string | undefined) {
  return claudeAccounts.list.find((account) => account.id === (id ?? DEFAULT_ACCOUNT));
}
/** What the pickers offer: accounts not removed. */
export function activeAccounts() {
  return claudeAccounts.list.filter((account) => !account.removed);
}
/** Whether a new chat can start on this account. */
export function accountReady(account: ClaudeAccount | undefined) {
  return !!account && !account.removed && !account.signingIn && account.auth?.loggedIn === true && account.auth.supported === true;
}
export function accountLabel(id: string | undefined) {
  const account = accountById(id);
  return account ? account.name : id === DEFAULT_ACCOUNT || !id ? "Default" : "Removed account";
}
export function accountColor(id: string | undefined) {
  return accountById(id)?.color ?? "#8296a2";
}
/** "you@example.com · Max", or the reason it can't be used. */
export function accountDetail(account: ClaudeAccount) {
  if (account.removed) return "Removed";
  if (account.signingIn) return "Signing in…";
  if (!account.auth) return "Checking sign-in…";
  if (!account.auth.loggedIn) return "Not signed in";
  if (!account.auth.supported) return "Unsupported sign-in";
  return [account.auth.email, account.auth.plan].filter(Boolean).join(" · ") || "Signed in";
}
/** ~ for the home folder, like the mock's mono paths. */
export function shortFolder(path: string) {
  const home = /^([A-Za-z]:\\Users\\[^\\]+|\/(?:home|Users)\/[^/]+)/.exec(path)?.[1];
  return home ? `~${path.slice(home.length)}` : path;
}

/** Ask the host to open a Terminal for an account's sign-in. */
export const CLAUDE_LOGIN_EVENT = "orvane:claude-login";
export interface ClaudeLoginDetail {
  ticket: string;
  name: string;
  /** Focus the Terminal already opened for this ticket. */
  show?: boolean;
}
/** Ask Agent sessions to open Settings (from a picker's "Add a Claude account"). */
export const CLAUDE_ACCOUNTS_EVENT = "orvane:claude-accounts";
