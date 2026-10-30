// Saved logins of the desktop Browser app (electron/passwords.mjs). This
// window only ever sees sites and usernames; passwords stay in the main
// process and go straight to the page they belong to, or to the clipboard.

export interface SavedLogin {
  id: string;
  origin: string;
  username: string;
  updated: number;
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
export interface PasswordsApi {
  list(): Promise<PasswordList | undefined>;
  remove(id: string): Promise<boolean>;
  allow(origin: string): Promise<boolean>;
  copy(id: string): Promise<boolean>;
  decide(id: string, choice: "save" | "never" | "dismiss"): Promise<boolean>;
  onPrompt(callback: (prompt: PasswordPrompt) => void): () => void;
}

export function siteName(origin: string) {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" ? url.host : origin;
  } catch {
    return origin;
  }
}
