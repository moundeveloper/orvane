// Which pages Orvane may sign in to by itself: genuine NetSuite login pages
// only, decided from the page's real URL (Chromium's, never the page's own
// claim), and only for the accounts auto sign-in covers. Everything else,
// lookalike hosts and redirects elsewhere included, gets nothing.

/** Production accounts that are used as development accounts. */
export const AUTO_LOGIN_ACCOUNTS = ["1964539"];

const SYSTEM_HOST = "system.netsuite.com";
// Account IDs as NetSuite writes them in host names: "1234567",
// "1234567-sb1", "tstdrv1234567", "1234567-rp".
const ACCOUNT = /^[a-z0-9]+(?:-[a-z]+\d*)?$/;
const APP_HOST = /^([a-z0-9]+(?:-[a-z]+\d*)?)\.app\.netsuite\.com$/;

/** "1234567_SB1" (NetSuite's `c` parameter) → "1234567-sb1". */
export function accountKey(value) {
  if (typeof value !== "string") return;
  const key = value.trim().toLowerCase().replace(/_/g, "-");
  return ACCOUNT.test(key) ? key : undefined;
}

/** A NetSuite host Orvane can trust: https, default port, exact names. */
function netSuiteUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password) return;
  const host = parsed.hostname.toLowerCase();
  if (host === SYSTEM_HOST) return { url: parsed, account: accountKey(parsed.searchParams.get("c") ?? "") };
  const match = APP_HOST.exec(host);
  if (match) return { url: parsed, account: match[1] };
}

/** Any page on a genuine NetSuite host (login, verification or app). */
export const isNetSuitePage = (url) => !!netSuiteUrl(url);

/** The account a genuine NetSuite URL names (host or `c` parameter). */
export const netSuiteAccount = (url) => netSuiteUrl(url)?.account;

/** A genuine NetSuite login page: `{ origin, account }` (account may be
 * unknown on system.netsuite.com without a `c` parameter). */
export function netSuiteLogin(url) {
  const page = netSuiteUrl(url);
  if (!page) return;
  const path = page.url.pathname.toLowerCase();
  const login =
    path.startsWith("/app/login/") ||
    (page.url.hostname === SYSTEM_HOST && path === "/pages/customerlogin.jsp");
  if (login) return { origin: page.url.origin, account: page.account };
}

/** Signed in: a NetSuite app page that is not part of the login flow. */
export function netSuiteSignedIn(url) {
  const page = netSuiteUrl(url);
  return (
    !!page &&
    page.url.hostname !== SYSTEM_HOST &&
    !page.url.pathname.toLowerCase().startsWith("/app/login/")
  );
}

/** Accounts auto sign-in covers: sandboxes and the listed accounts. */
export function autoLoginAccount(account) {
  if (!account) return false;
  return /-sb\d+$/.test(account) || AUTO_LOGIN_ACCOUNTS.includes(account);
}

/** The account a saved login belongs to, from where it was saved. */
const savedAccount = (origin) => netSuiteUrl(origin)?.account;
const baseAccount = (account) => account?.replace(/-[a-z]+\d*$/, "");

/** Saved logins that may sign in to this login page, best first: one saved
 * on this page's own host, on system.netsuite.com, or on another
 * environment of the same account (its production or another sandbox). */
export function autoLoginCandidates(logins, login) {
  return logins
    .filter((saved) => {
      if (saved.autoLogin === false) return false;
      if (saved.origin === login.origin) return true;
      let host;
      try {
        host = new URL(saved.origin).hostname;
      } catch {
        return false;
      }
      if (!isNetSuitePage(saved.origin)) return false;
      if (host === SYSTEM_HOST) return true;
      return !!login.account && baseAccount(savedAccount(saved.origin)) === baseAccount(login.account);
    })
    .sort((a, b) => Math.max(b.used ?? 0, b.updated) - Math.max(a.used ?? 0, a.updated));
}
