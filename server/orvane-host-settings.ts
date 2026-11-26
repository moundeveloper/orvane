import { networkInterfaces } from "node:os";
import { z } from "zod";
import { hostPasswordMaximum, hostPasswordMinimum } from "../src/hostPassword.ts";
import { LocalDatabase } from "./database.ts";
import { localHostCertificate } from "./orvane-host-cert.ts";
import { hostProjectList } from "./orvane-host-chat.ts";
import { makeHostPasswordVerifier, privateAddress, startOrvaneHost, type HostSessions } from "./orvane-host.ts";

export const hostSettingsAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("stop") }),
  // Disconnect for a desktop restart; Host turns back on at the next launch.
  z.strictObject({ action: z.literal("suspend") }),
  z.strictObject({ action: z.literal("certificate") }),
  z.strictObject({
    action: z.literal("start"),
    address: z.ipv4(),
    port: z.number().int().min(0).max(65535),
    projects: hostProjectList,
    password: z.string().min(hostPasswordMinimum).max(hostPasswordMaximum).optional(),
    approvals: z.boolean(),
    uiMaker: z.boolean(),
    terminal: z.boolean().default(false),
    browser: z.boolean().default(false),
    keepAwake: z.boolean().default(true),
  }),
]);

type Config = {
  address: string; port: number; projects: string[]; approvals: boolean; uiMaker: boolean; terminal: boolean; browser: boolean; keepAwake: boolean; verifier: string;
  /** Host was on when last changed: it turns back on at the next launch. */
  enabled?: boolean;
  /** The desktop page the Browser share was started from. */
  origin?: string;
};
type Source = Pick<Parameters<typeof startOrvaneHost>[0], "recent" | "chat" | "agents" | "maker" | "terminal" | "browser" | "desktop">;
type Listener = Awaited<ReturnType<typeof startOrvaneHost>>;
const preference = "orvane-host-settings";
// Laptop sign-ins (hashed tokens) kept while Orvane restarts; turning Host off clears them.
const signIns = "orvane-host-sign-ins";

export class HostSettings {
  private db?: LocalDatabase;
  private listener?: Listener;
  private certificate?: string;
  private awake = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private directory: string,
    private filename: string,
    private source: (projects: string[], approvals: boolean, uiMaker: boolean, terminal: boolean, browserOrigin?: string, desktopOrigin?: string) => Source,
  ) {}

  private database() { return (this.db ??= new LocalDatabase(this.filename)); }
  private config() { return this.database().appData(preference) as Config | undefined; }
  get keepAwake() { return this.awake && !!this.listener; }

  private addresses() {
    return Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
      .filter(({ address, internal }) => !internal && privateAddress(address))
      .map(({ address }) => ({ address, name })))
      .concat([{ address: "127.0.0.1", name: "This computer only" }]);
  }

  private status() {
    const saved = this.config();
    const addresses = this.addresses();
    return {
      enabled: !!this.listener, url: this.listener?.url, addresses,
      address: saved?.address ?? addresses[0]?.address, port: saved?.port ?? 8443,
      projects: saved?.projects ?? [], approvals: saved?.approvals ?? false, uiMaker: saved?.uiMaker ?? false,
      terminal: saved?.terminal ?? false,
      browser: saved?.browser ?? false,
      keepAwake: saved?.keepAwake ?? true,
      passwordSet: !!saved?.verifier, certificateReady: !!this.certificate,
    };
  }

  private exclusive<T>(operation: () => Promise<T>) {
    const work = this.queue.then(operation);
    this.queue = work.catch(() => undefined);
    return work;
  }

  execute(input: z.infer<typeof hostSettingsAction>, origin: string) {
    return this.exclusive(async () => {
      if (input.action === "certificate") {
        if (!this.certificate) throw Error("Enable Host access first.");
        return { certificate: this.certificate };
      }
      if (input.action === "stop" || input.action === "suspend") {
        await this.shut(input.action === "suspend");
        this.certificate = undefined;
        const saved = this.config();
        if (input.action === "stop" && saved?.enabled) this.database().saveAppData(preference, { ...saved, enabled: false });
      } else if (input.action === "start") {
        if (this.listener) throw Error("Turn hosting off before changing its settings.");
        if (!this.addresses().some(({ address }) => address === input.address))
          throw Error("Select a private network interface on this computer.");
        const verifier = input.password ? await makeHostPasswordVerifier(input.password) : this.config()?.verifier;
        if (!verifier) throw Error("Set an access password first.");
        const { address, port, projects, approvals, uiMaker, terminal, browser, keepAwake } = input;
        const config = { address, port, projects, approvals, uiMaker, terminal, browser, keepAwake, verifier, enabled: true, origin };
        await this.open(config, () => {
          this.database().saveAppData(preference, config);
          this.database().saveAppData(signIns, []);
        });
      }
      return this.status();
    });
  }

  /** Close the listener; keep its sign-ins for the next launch, or forget them. */
  private async shut(keep: boolean) {
    if (this.listener) {
      this.database().saveAppData(signIns, keep ? this.listener.sessions() : []);
      await this.listener.close();
    }
    this.listener = undefined;
    this.awake = false;
  }

  private async open(config: Config, save?: () => void, sessions?: HostSessions) {
    const { address, port, projects, approvals, uiMaker, terminal, browser, keepAwake, verifier } = config;
    const material = await localHostCertificate(this.directory, address);
    const source = this.source(projects, approvals, uiMaker, terminal, browser ? config.origin : undefined, config.origin);
    const listener = await startOrvaneHost({ address, port, verifier, tls: material.tls, ...source, sessions });
    try { save?.(); }
    catch (error) { await listener.close(); throw error; }
    this.listener = listener;
    this.certificate = material.trust;
    this.awake = keepAwake;
  }

  /** At launch: turn Host back on if it was on, with its saved settings. */
  restore() {
    return this.exclusive(async () => {
      const saved = this.config();
      if (this.listener || !saved?.enabled) return;
      if (!this.addresses().some(({ address }) => address === saved.address))
        throw Error(`Host stays off: ${saved.address} is not on this computer's network now.`);
      const kept = this.database().appData(signIns);
      await this.open(saved, undefined, Array.isArray(kept) ? kept as HostSessions : []);
    });
  }

  adopt(start: () => Promise<Listener | undefined>, keepAwake = false) {
    return this.exclusive(async () => {
      if (!this.listener) {
        this.listener = await start();
        this.awake = keepAwake;
      }
    });
  }

  close() {
    return this.exclusive(async () => {
      await this.shut(true);
      this.db?.close();
      this.db = undefined;
    });
  }
}
