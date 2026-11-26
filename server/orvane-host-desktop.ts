import { BrowserBridge } from "./bridge.ts";
import { HostChatError } from "./orvane-host-chat.ts";

/** Asks the desktop Orvane window to restart, as the desktop_restart tool does. */
export class HostDesktop {
  private bridge: BrowserBridge;
  constructor(directory: string, origin: string) {
    this.bridge = new BrowserBridge(directory, [origin]);
  }
  async start() {
    await this.bridge.listen(0);
  }
  async restart() {
    if (!this.bridge.list().length)
      throw new HostChatError(503, "The Orvane desktop window isn't connected yet. Try again in a moment.");
    let result: unknown;
    try {
      result = await this.bridge.request({ run: { kind: "desktop-restart", action: "schedule" } });
    } catch (error) {
      throw new HostChatError(409, error instanceof Error ? error.message : "Could not reach the desktop window.");
    }
    if (!result || typeof result !== "object" || !("restart" in result))
      throw new HostChatError(409, "Reload the desktop Orvane window, then try again.");
    return result.restart as { state: string };
  }
  close() { return this.bridge.close(); }
}
