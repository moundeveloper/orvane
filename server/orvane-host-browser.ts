import type { HostBrowserInput } from "../src/hostBrowser.ts";
import { BrowserBridge } from "./bridge.ts";
import { HostChatError } from "./orvane-host-chat.ts";

export class HostBrowser {
  private bridge: BrowserBridge;
  constructor(directory: string, origin: string) {
    this.bridge = new BrowserBridge(directory, [origin]);
  }
  async start() {
    await this.bridge.listen(0);
  }
  async execute(request: HostBrowserInput) {
    if (!this.bridge.list().length)
      throw new HostChatError(503, "Waiting for the Orvane desktop window.");
    try {
      const result = await this.bridge.request({ run: { kind: "host-browser", request } });
      if (!result || typeof result !== "object" || !("browser" in result))
        throw Error("Reload the desktop Orvane window to use Host Browser.");
      return result.browser;
    } catch (error) {
      throw new HostChatError(409, error instanceof Error ? error.message : "Could not reach the desktop Browser.");
    }
  }
  close() { return this.bridge.close(); }
}
