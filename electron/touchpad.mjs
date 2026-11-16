// Free two-finger panning on Windows touchpads. Windows locks touchpad
// scroll messages to one axis when a gesture starts along it ("rails"), and
// no app can undo that from scroll events. touchpad.cs reads the fingers
// themselves through Raw Input and reports their movement, which Orvane's
// canvas uses for panning (see App.vue). Windows only; quietly does nothing
// if PowerShell or the touchpad is unavailable.
import { spawn } from "node:child_process";
import { BrowserWindow } from "electron";
import { join } from "node:path";

export function setupTouchpad(root) {
  if (process.platform !== "win32") return () => undefined;
  const source = join(root, "electron", "touchpad.cs").replace(/'/g, "''");
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Add-Type -TypeDefinition (Get-Content -Raw '${source}') -ReferencedAssemblies System.Windows.Forms; [OrvaneTouchpad]::Run(${process.pid})`,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  child.on("error", () => undefined);
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) handle(line.trim());
  });
  function handle(line) {
    // Only the focused Orvane window pans; elsewhere the fingers are ignored.
    const window = BrowserWindow.getFocusedWindow();
    if (!window || window.isDestroyed()) return;
    if (line === "e") return window.webContents.send("orvane:touchpad", { end: true });
    const match = /^m (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)$/.exec(line);
    if (!match) return;
    const fx = Number(match[1]),
      fy = Number(match[2]);
    if (!Number.isFinite(fx) || !Number.isFinite(fy) || Math.abs(fx) > 1 || Math.abs(fy) > 1) return;
    window.webContents.send("orvane:touchpad", { fx, fy });
  }
  return () => {
    if (!child.killed) child.kill();
  };
}
