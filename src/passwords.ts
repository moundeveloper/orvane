// Saved logins of the desktop Browser app (electron/passwords.mjs). This
// window only ever sees sites and usernames; passwords stay in the main
// process and go straight to the page they belong to, or to the clipboard.

export interface SavedLogin {
  id: string;
  origin: string;
  username: string;
  updated: number;
  /** NetSuite logins only: signs in by itself on NetSuite login pages. */
  autoLogin?: boolean;
}
export interface PasswordList {
  /** "unavailable": no OS encryption; "unreadable": the vault can't be opened. */
  state: "ok" | "unavailable" | "unreadable";
  logins: SavedLogin[];
  /** Sites where the user chose never to save. */
  never: string[];
}
export interface PasswordPrompt {
  from: number;
  id: string;
  origin: string;
  username: string;
  update: boolean;
}
/** NetSuite auto sign-in in a Browser page: started, done, stopped because
 * the login page came back ("failed") or an earlier one failed ("paused"),
 * or waiting for the user's verification code ("challenge"). */
export interface AutoLoginUpdate {
  from: number;
  kind: "signing-in" | "done" | "failed" | "paused" | "challenge";
  origin: string;
}
export interface PasswordsApi {
  list(): Promise<PasswordList | undefined>;
  remove(id: string): Promise<boolean>;
  allow(origin: string): Promise<boolean>;
  copy(id: string): Promise<boolean>;
  setAutoLogin(id: string, on: boolean): Promise<boolean>;
  decide(id: string, choice: "save" | "never" | "dismiss"): Promise<boolean>;
  onPrompt(callback: (prompt: PasswordPrompt) => void): () => void;
  onAutoLogin(callback: (update: AutoLoginUpdate) => void): () => void;
}

export function siteName(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.host : origin;
  } catch {
    return origin;
  }
}
