// Claude account sign-in: the Settings page asks the agents API for a
// one-time ticket; the Terminal app opens a pane whose profile is
// `claude-login:<ticket>`, and server/terminal.ts starts exactly
// `claude auth login` (executable + args, no shell) with that account's env.
// The renderer never sends a command or env. The CLI owns the browser
// sign-in and stores the credentials in the account's folder.
import { randomBytes } from "node:crypto";
import type { AgentCommand } from "./agent-cli.ts";

export const LOGIN_PREFIX = "claude-login:";
const TICKET_MS = 2 * 60 * 1000;

export interface LoginLaunch {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  name: string;
}
interface Ticket {
  ticket: string;
  scope: string;
  profileId: string;
  launch: LoginLaunch;
  expires: number;
  /** Set once the PTY started; the ticket can then only re-attach. */
  started?: boolean;
  ended?: boolean;
  kill?: () => void;
  onEnd?: (code: number | null) => void;
}

const tickets = new Map<string, Ticket>();
/** scope|profileId → ticket of the sign-in that is open (one per account). */
const active = new Map<string, string>();
const slot = (scope: string, profileId: string) => `${scope}|${profileId}`;

function sweep() {
  const now = Date.now();
  for (const [id, t] of tickets)
    if (!t.started && t.expires < now) {
      tickets.delete(id);
      if (active.get(slot(t.scope, t.profileId)) === id) active.delete(slot(t.scope, t.profileId));
    }
}

/** Whether this account has a sign-in open (pending or running). */
export function loginActive(scope: string, profileId: string) {
  sweep();
  return active.has(slot(scope, profileId));
}

export function issueLogin(
  scope: string,
  profileId: string,
  name: string,
  command: AgentCommand,
  env: Readonly<NodeJS.ProcessEnv>,
  cwd: string,
  onEnd: (code: number | null) => void,
) {
  sweep();
  if (active.has(slot(scope, profileId))) throw Error(`A sign-in for ${name} is already open.`);
  const ticket = randomBytes(18).toString("base64url");
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") clean[key] = value;
  tickets.set(ticket, {
    ticket,
    scope,
    profileId,
    expires: Date.now() + TICKET_MS,
    onEnd,
    launch: {
      file: command.file,
      args: [...command.args, "auth", "login"],
      cwd,
      env: { ...clean, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Orvane" },
      name: `Claude sign-in · ${name}`,
    },
  });
  active.set(slot(scope, profileId), ticket);
  return ticket;
}

/** The terminal server takes the launch once; later opens may only re-attach. */
export function claimLogin(ticket: string): { launch: LoginLaunch; started: (kill: () => void) => void; ended: (code: number | null) => void } | null {
  sweep();
  const entry = tickets.get(ticket);
  if (!entry || entry.started || entry.ended) return null;
  entry.started = true;
  return {
    launch: entry.launch,
    started: (kill) => {
      entry.kill = kill;
    },
    ended: (code) => {
      if (entry.ended) return;
      entry.ended = true;
      tickets.delete(ticket);
      if (active.get(slot(entry.scope, entry.profileId)) === ticket) active.delete(slot(entry.scope, entry.profileId));
      entry.onEnd?.(code);
    },
  };
}

/** Cancel the account's open sign-in: ends its PTY or drops the unused ticket. */
export function cancelLogin(scope: string, profileId: string) {
  const id = active.get(slot(scope, profileId));
  if (!id) return false;
  const entry = tickets.get(id);
  if (!entry) {
    active.delete(slot(scope, profileId));
    return true;
  }
  // A kill request is asynchronous. Keep the account reserved until the PTY's
  // exit callback calls ended(), so a new run cannot race credential writes.
  if (entry.kill) entry.kill();
  else {
    active.delete(slot(scope, profileId));
    tickets.delete(id);
    entry.ended = true;
    entry.onEnd?.(null);
  }
  return true;
}

/** The open sign-in's ticket, for "Show Terminal". */
export function loginTicket(scope: string, profileId: string) {
  sweep();
  return active.get(slot(scope, profileId));
}
