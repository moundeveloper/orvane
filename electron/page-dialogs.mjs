// Browser page popups (alert, confirm, prompt) shown as Orvane cards.
// page-dialogs.cjs sends the page's call here synchronously; this forwards it
// to the Browser app that owns the tab and answers the page when the card is
// answered. If no Browser app claims it quickly (a hidden processing page,
// a tab whose app is gone), the page falls back to its native popup, so a
// page never waits on a card nobody can see.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ipcMain, session, webContents } from "electron";

const CLAIM_TIME = 1500;
const KINDS = new Set(["alert", "confirm", "prompt"]);
const LIMIT = 4000;

/**
 * @param {{ partition: string, isProcessing?: (contents: Electron.WebContents) => boolean }} options
 */
export function setupPageDialogs({ partition, isProcessing = () => false }) {
  session.fromPartition(partition).registerPreloadScript({
    type: "frame",
    id: "orvane-page-dialogs",
    filePath: join(import.meta.dirname, "page-dialogs.cjs"),
  });

  /** @type {Map<string, { guest: number, host: number, reply: (answer: object) => void, claim?: NodeJS.Timeout }>} */
  const open = new Map();

  function finish(id, answer) {
    const entry = open.get(id);
    if (!entry) return;
    open.delete(id);
    clearTimeout(entry.claim);
    entry.reply(answer);
    const host = webContents.fromId(entry.host);
    if (host && !host.isDestroyed()) host.send("orvane:page-dialog-done", id);
  }

  ipcMain.on("orvane:page-dialog", (event, kind, message, value) => {
    const guest = event.sender;
    const host = guest.getType() === "webview" ? guest.hostWebContents : null;
    if (!KINDS.has(kind) || !host || host.isDestroyed() || isProcessing(guest)) {
      event.returnValue = { native: true };
      return;
    }
    let origin = "";
    try {
      origin = new URL(event.senderFrame?.url ?? guest.getURL()).host;
    } catch {}
    const id = randomUUID();
    let replied = false;
    const reply = (answer) => {
      if (replied) return;
      replied = true;
      event.returnValue = answer;
    };
    // A page that goes away or leaves gives up its question.
    const drop = () => finish(id, { ok: false });
    const leave = (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) drop();
    };
    guest.once("destroyed", drop);
    guest.on("did-start-navigation", leave);
    open.set(id, {
      guest: guest.id,
      host: host.id,
      reply: (answer) => {
        if (!guest.isDestroyed()) {
          guest.off("destroyed", drop);
          guest.off("did-start-navigation", leave);
        }
        reply(answer);
      },
      claim: setTimeout(() => finish(id, { native: true }), CLAIM_TIME),
    });
    host.send("orvane:page-dialog", {
      id,
      from: guest.id,
      kind,
      origin,
      message: String(message ?? "").slice(0, LIMIT),
      value: String(value ?? "").slice(0, LIMIT),
    });
  });

  /** Only the Orvane window that hosts the asking page may claim or answer. */
  const mine = (event, id) => {
    const entry = open.get(id);
    return entry && event.sender.id === entry.host ? entry : undefined;
  };
  ipcMain.handle("orvane:page-dialog-claim", (event, id) => {
    const entry = mine(event, id);
    if (!entry) return false;
    clearTimeout(entry.claim);
    entry.claim = undefined;
    return true;
  });
  ipcMain.handle("orvane:page-dialog-answer", (event, id, ok, value) => {
    if (!mine(event, id)) return false;
    finish(id, { ok: ok === true, value: typeof value === "string" ? value.slice(0, LIMIT) : "" });
    return true;
  });
}
