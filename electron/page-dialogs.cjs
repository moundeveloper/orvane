// Runs in every Browser page frame (sandboxed, isolated world). Hands the
// page's alert(), confirm() and prompt() to Orvane, which shows them as an
// Orvane card on that tab instead of Electron's native popup. The page still
// gets a synchronous answer: the call blocks until the card is answered.
// When no Browser app shows the card (a hidden page, Orvane busy), the main
// process answers { native: true } and the page's own native popup runs.
const { contextBridge, ipcRenderer } = require("electron");

function ask(kind, message, value) {
  try {
    return ipcRenderer.sendSync("orvane:page-dialog", kind, message, value);
  } catch {
    return { native: true };
  }
}

try {
  contextBridge.executeInMainWorld({
    func: (ask) => {
      const native = {
        alert: window.alert,
        confirm: window.confirm,
        prompt: window.prompt,
      };
      const text = (value) => (value === undefined ? "" : String(value));
      window.alert = function alert(message) {
        const answer = ask("alert", text(message), "");
        if (answer?.native) return native.alert.call(window, message);
      };
      window.confirm = function confirm(message) {
        const answer = ask("confirm", text(message), "");
        if (answer?.native) return native.confirm.call(window, message);
        return answer?.ok === true;
      };
      window.prompt = function prompt(message, value) {
        const answer = ask("prompt", text(message), text(value));
        if (answer?.native) return native.prompt.call(window, message, value);
        return answer?.ok === true ? String(answer.value ?? "") : null;
      };
    },
    args: [ask],
  });
} catch {
  // Without context isolation the page keeps Electron's native popups.
}
