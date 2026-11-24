import { networkInterfaces } from "node:os";
import { z } from "zod";
import { hostPasswordMaximum, hostPasswordMinimum } from "../src/hostPassword.ts";
import { LocalDatabase } from "./database.ts";
import { localHostCertificate } from "./orvane-host-cert.ts";
import { hostProjectList } from "./orvane-host-chat.ts";
import { makeHostPasswordVerifier, privateAddress, startOrvaneHost } from "./orvane-host.ts";

export const hostSettingsAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("status") }),
  z.strictObject({ action: z.literal("stop") }),
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
};
type Source = Pick<Parameters<typeof startOrvaneHost>[0], "recent" | "chat" | "maker" | "terminal" | "browser">;
type Listener = Awaited<ReturnType<typeof startOrvaneHost>>;
const preference = "orvane-host-settings";

export class HostSettings {
  private db?: LocalDatabase;
  private listener?: Listener;
  private certificate?: string;
  private awake = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private directory: string,
    private filename: string,
    private source: (projects: string[], approvals: boolean, uiMaker: boolean, terminal: boolean, browserOrigin?: string) => Source,
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
      if (input.action === "stop") {
        await this.listener?.close();
        this.listener = undefined;
        this.certificate = undefined;
        this.awake = false;
      } else if (input.action === "start") {
        if (this.listener) throw Error("Turn hosting off before changing its settings.");
        if (!this.addresses().some(({ address }) => address === input.address))
          throw Error("Select a private network interface on this computer.");
        const verifier = input.password ? await makeHostPasswordVerifier(input.password) : this.config()?.verifier;
        if (!verifier) throw Error("Set an access password first.");
        const { address, port, projects, approvals, uiMaker, terminal, browser, keepAwake } = input;
        const config = { address, port, projects, approvals, uiMaker, terminal, browser, keepAwake, verifier };
        const material = await localHostCertificate(this.directory, address);
        const source = this.source(projects, approvals, uiMaker, terminal, browser ? origin : undefined);
        const listener = await startOrvaneHost({ address, port, verifier, tls: material.tls, ...source });
        try { this.database().saveAppData(preference, config); }
        catch (error) { await listener.close(); throw error; }
        this.listener = listener;
        this.certificate = material.trust;
        this.awake = keepAwake;
      }
      return this.status();
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
      await this.listener?.close();
      this.listener = undefined;
      this.awake = false;
      this.db?.close();
      this.db = undefined;
    });
  }
}
