import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type ServerOptions } from "node:https";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { agentNames, type AgentRunSummary } from "../src/agentSessions.ts";
import { hostBrowserInput } from "../src/hostBrowser.ts";
import { hostPasswordMaximum, hostPasswordMinimum } from "../src/hostPassword.ts";
import { hostCss, hostNavScript, signInPage, watchPage, watchScript } from "./orvane-host-view.ts";
import { chatCss, chatPage, chatScript } from "./orvane-host-chat-view.ts";
import { HostChatError, hostChatAction, hostProjectList, hostSessionId, type HostAgentChat } from "./orvane-host-chat.ts";
import { makerCss, makerPage, makerScript } from "./orvane-host-maker-view.ts";
import { terminalCss, terminalPage, terminalScript, xtermCssPath, xtermScriptPath } from "./orvane-host-terminal-view.ts";
import { hostTerminalOutput, hostTerminals, writeHostTerminal } from "./terminal.ts";
import type { HostBrowser } from "./orvane-host-browser.ts";
import { browserCss, browserPage, browserScript } from "./orvane-host-browser-view.ts";
import type { UiMakerService } from "./uimaker.ts";

const sessionCookie = "__Host-orvane";
const brandAssets = new Map([
  ["/favicon.png", { url: new URL("../public/favicon.png", import.meta.url), type: "image/png" }],
  ["/inter-latin.woff2", {
    url: new URL(import.meta.resolve("@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")),
    type: "font/woff2",
  }],
]);
const markdownLibraries = new Map([
  // Browser builds beside each package's resolved entry (not in "exports").
  ["/marked.js", new URL("./marked.umd.js", import.meta.resolve("marked"))],
  ["/purify.js", new URL("./purify.min.js", import.meta.resolve("dompurify"))],
]);
const sessionAge = 8 * 60 * 60;
const derive = promisify(scrypt);
const verifierPattern = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/;

export async function makeHostPasswordVerifier(password: string) {
  if (password.length < hostPasswordMinimum || password.length > hostPasswordMaximum)
    throw Error(`Use a host password between ${hostPasswordMinimum} and ${hostPasswordMaximum} characters.`);
  const salt = randomBytes(16);
  const hash = await derive(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

const ipNumber = (ip: string) => ip.split(".").reduce((number, part) => number * 256 + Number(part), 0);
export function privateAddress(ip: string) {
  return isIPv4(ip) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip);
}

type HostOptions = {
  address: string;
  hostname?: string;
  port: number;
  verifier: string;
  tls: Pick<ServerOptions, "cert" | "key">;
  recent: () => AgentRunSummary[];
  chat?: HostAgentChat;
  maker?: UiMakerService;
  terminal?: boolean;
  browser?: HostBrowser;
};
const makerId = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const makerPick = z.strictObject({ component: makerId, round: makerId, variant: makerId });
const terminalId = z.string().regex(/^[a-f0-9]{64}$/);
const terminalInput = z.strictObject({ terminal: terminalId, input: z.string().min(1).max(8192) });

async function body(request: IncomingMessage, limit: number) {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of request.iterator({ destroyOnReturn: false })) {
    const chunk = part as Buffer;
    size += chunk.length;
    if (size > limit) return null;
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString("utf8");
}

async function form(request: IncomingMessage) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded")
    return null;
  const input = await body(request, 4096);
  return input === null ? null : new URLSearchParams(input);
}

export async function startOrvaneHost(options: HostOptions) {
  const { address, port, tls, recent, chat, maker, browser } = options;
  const terminal = !!(options.terminal && chat);
  await chat?.ready();
  const hostname = options.hostname ?? address;
  const adapter = Object.values(networkInterfaces()).flat().find((item) => item?.address === address);
  if (!privateAddress(address) || !adapter || !isIPv4(adapter.netmask) || adapter.netmask === "0.0.0.0")
    throw Error("Choose a private IPv4 address assigned to this machine.");
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname) ||
      !Number.isInteger(port) || port < 0 || port > 65535)
    throw Error("The Host name or port is invalid.");
  const verifier = verifierPattern.exec(options.verifier);
  if (!verifier) throw Error("The Host password verifier is invalid.");
  const salt = Buffer.from(verifier[1]!, "hex");
  const expected = Buffer.from(verifier[2]!, "hex");
  const mask = ipNumber(adapter.netmask);
  const subnet = ipNumber(address) & mask;
  const keyFor = (token: string) => createHash("sha256").update(token).digest("hex");
  const sessions = new Map<string, { expires: number; csrf: string }>();
  const attempts = new Map<string, { until: number; count: number }>();
  let verifying = 0;
  let origin: URL;

  const server = createServer({ ...tls, minVersion: "TLSv1.2", requestTimeout: 10_000, headersTimeout: 8_000 },
    (req, res) => {
      void serve(req, res).catch(() => {
        if (!res.headersSent && !res.destroyed) res.writeHead(500).end();
        else res.destroy();
      });
    });

  async function serve(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const remote = req.socket.remoteAddress ?? "";
    if (!origin || req.headers.host !== origin.host ||
        !privateAddress(remote) || (ipNumber(remote) & mask) !== subnet ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin && req.headers.origin !== origin.origin)) {
      res.writeHead(403).end();
      return;
    }
    const text = (status: number, content: string, type = "text/html") => {
      res.writeHead(status, { "Content-Type": type + "; charset=utf-8" }).end(content);
    };
    const json = (status: number, data: unknown) => text(status, JSON.stringify(data), "application/json");
    const setCookie = (token: string, age: number) => res.setHeader(
      "Set-Cookie", `${sessionCookie}=${token}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Strict`,
    );
    const redirect = () => res.writeHead(303, { Location: "/" }).end();
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(sessionCookie + "="))?.slice(sessionCookie.length + 1);
    const now = Date.now();
    const sessionKey = cookie && /^[a-f0-9]{64}$/.test(cookie) ? keyFor(cookie) : "";
    const session = sessions.get(sessionKey);
    const authorized = session !== undefined && session.expires > now;
    if (!authorized && sessionKey) sessions.delete(sessionKey);

    if (req.method === "GET" && req.url === "/")
      return text(200, authorized ? chat ? chatPage(!!maker, terminal, !!browser) : watchPage(false, !!maker, terminal, !!browser) : signInPage());
    if (req.method === "GET" && req.url === "/host.css")
      return text(200, hostCss + chatCss + makerCss + terminalCss + browserCss, "text/css");
    const asset = req.method === "GET" && brandAssets.get(req.url ?? "");
    if (asset) {
      const data = await readFile(asset.url);
      res.writeHead(200, { "Content-Type": asset.type }).end(data);
      return;
    }
    if (req.method === "POST" && (req.url === "/login" || req.url === "/logout")) {
      if (req.headers.origin !== origin.origin) return void res.writeHead(403).end();
      if (req.url === "/logout") {
        sessions.delete(sessionKey);
        setCookie("", 0);
        return void redirect();
      }
      for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip);
      const attempt = attempts.get(remote) ?? { count: 0, until: now + 60_000 };
      if (attempt.count >= 5 || verifying >= 2 || (attempts.size >= 256 && !attempts.has(remote)))
        return text(429, signInPage(true));
      attempt.count++;
      attempts.set(remote, attempt);
      verifying++;
      let allowed: boolean;
      try {
        const password = (await form(req))?.get("password");
        allowed = !!password && password.length <= hostPasswordMaximum &&
          timingSafeEqual(expected, await derive(password, salt, 64) as Buffer);
      } finally {
        verifying--;
      }
      if (!allowed) return text(401, signInPage(true));
      attempts.delete(remote);
      sessions.delete(sessionKey);
      for (const [key, member] of sessions) if (member.expires <= now) sessions.delete(key);
      if (sessions.size >= 16) sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString("hex");
      sessions.set(keyFor(token), { expires: now + sessionAge * 1000, csrf: randomBytes(32).toString("hex") });
      setCookie(token, sessionAge);
      return void redirect();
    }

    if (req.method === "GET" && (req.url === "/runs" || req.url === "/maker" || req.url === "/terminal" || req.url === "/browser")) {
      if (!authorized) return void redirect();
      if (req.url === "/runs") return text(200, watchPage(!!chat, !!maker, terminal, !!browser));
      if (req.url === "/maker" && maker) return text(200, makerPage(!!chat, terminal, !!browser));
      if (req.url === "/terminal" && terminal) {
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        return text(200, terminalPage(!!maker, !!browser));
      }
      if (req.url === "/browser" && browser) {
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        return text(200, browserPage(!!chat, !!maker, terminal));
      }
    }
    if (!authorized) return void res.writeHead(401).end();
    if (req.method === "GET" && req.url === "/navigation.js") return text(200, hostNavScript, "text/javascript");
    // Desktop ChatMarkdown's parser and sanitizer, so replies render the same.
    const library = req.method === "GET" && markdownLibraries.get(req.url ?? "");
    if (library) {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }).end(await readFile(library));
      return;
    }
    if (req.method === "GET" && req.url === "/watch.js") return text(200, watchScript, "text/javascript");
    if (req.method === "GET" && req.url === "/api/runs") {
      const runs = await Promise.all(recent().map(async ({ provider, title, status, awaitingApproval, folder }) =>
        !chat || await chat.allowedFolder(folder) ? { provider: agentNames[provider], title, status, awaitingApproval } : undefined));
      return json(200, { runs: runs.filter(Boolean) });
    }
    const url = new URL(req.url ?? "/", origin);
    if (url.origin !== origin.origin) return void res.writeHead(403).end();
    async function mutation() {
      if (req.headers.origin !== origin.origin || req.headers["x-orvane-csrf"] !== session!.csrf)
        throw new HostChatError(403, "Sign in again to control this host.");
      if (req.headers["content-type"]?.split(";")[0] !== "application/json")
        throw new HostChatError(415, "Expected a JSON request.");
      const input = await body(req, 96_000);
      if (input === null) throw new HostChatError(413, "The request is too large.");
      if (sessions.get(sessionKey) !== session || session!.expires <= Date.now())
        throw new HostChatError(401, "Sign in again.");
      try {
        return JSON.parse(input) as unknown;
      } catch {
        throw new HostChatError(400, "Invalid request.");
      }
    }

    try {
      if (chat) {
        if (req.method === "GET" && req.url === "/chat.js") return text(200, chatScript, "text/javascript");
        if (req.method === "GET" && req.url === "/api/sessions")
          return json(200, {
            sessions: await chat.sessions(), projects: await chat.projects(), modes: chat.defaultModes(), csrf: session.csrf,
          });
        if (url.pathname === "/api/chat" && req.method === "GET") {
          const id = hostSessionId.safeParse(url.searchParams.get("session"));
          return id.success ? json(200, await chat.read(id.data)) : json(400, { error: "Choose a session." });
        }
        if (url.pathname === "/api/chat" && req.method === "POST") {
          const action = hostChatAction.safeParse(await mutation());
          return action.success
            ? json(202, await chat.act(action.data))
            : json(400, { error: "Check the selected session and message." });
        }
      }
      if (maker) {
        if (req.method === "GET" && req.url === "/maker.js") return text(200, makerScript, "text/javascript");
        if (req.method === "GET" && req.url === "/api/maker/components")
          return json(200, { components: maker.readState().components.map(({ id, name }) => ({ id, name })), csrf: session.csrf });
        if (req.method === "GET" && (url.pathname === "/api/maker/component" || url.pathname === "/api/maker/preview")) {
          const component = makerId.safeParse(url.searchParams.get("component"));
          if (!component.success) return json(400, { error: "Choose a component." });
          const id = component.data;
          if (!maker.readState().components.some((value) => value.id === id)) return json(404, { error: "Component unavailable." });
          if (url.pathname === "/api/maker/component") {
            const [versions, rounds] = await Promise.all([maker.versions(id), maker.labRounds(id)]);
            return json(200, {
              versions: versions.map(({ n, response }) => ({ n, summary: response?.summary })),
              rounds: rounds.map(({ id, title, status, picked, variants }) => ({
                id, title, status, picked, variants: variants.map(({ id, label }) => ({ id, label })),
              })),
            });
          }
          const variant = url.searchParams.get("variant");
          const round = url.searchParams.get("round");
          const version = url.searchParams.get("version");
          let html: string;
          if (variant !== null || round !== null) {
            if (!makerId.safeParse(variant).success || !makerId.safeParse(round).success)
              return json(400, { error: "Choose a Lab variant." });
            html = (await maker.labRead(id, variant!, round!)).html;
          } else {
            if (!version || !/^\d{1,8}$/.test(version)) return json(400, { error: "Choose a version." });
            html = (await maker.readVersion(id, Number(version))).html;
          }
          // Even a direct navigation to a saved mock runs in an opaque sandbox.
          res.setHeader("Content-Security-Policy", "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-src about:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'");
          return text(200, html);
        }
        if (req.method === "POST" && url.pathname === "/api/maker/pick") {
          const pick = makerPick.safeParse(await mutation());
          if (!pick.success) return json(400, { error: "Choose a Lab variant." });
          const { component, round, variant } = pick.data;
          try {
            return json(200, await maker.labPick(component, variant, round));
          } catch {
            return json(409, { error: "That variant could not be picked. Refresh the round." });
          }
        }
      }
      if (terminal && chat) {
        const allowed = async (folder: string) => {
          const value = await chat.allowedFolder(folder);
          return sessions.get(sessionKey) === session && session.expires > Date.now() ? value : undefined;
        };
        if (req.method === "GET") {
          if (req.url === "/terminal.js") return text(200, terminalScript, "text/javascript");
          if (req.url === "/terminal/xterm.js") return text(200, await readFile(xtermScriptPath(), "utf8"), "text/javascript");
          if (req.url === "/terminal/xterm.css") return text(200, await readFile(xtermCssPath(), "utf8"), "text/css");
          if (req.url === "/api/terminal")
            return json(200, { terminals: await hostTerminals(allowed), csrf: session.csrf });
          if (url.pathname === "/api/terminal/output") {
            const cursor = Number(url.searchParams.get("cursor"));
            const id = terminalId.safeParse(url.searchParams.get("terminal"));
            if (!id.success || !Number.isSafeInteger(cursor) || cursor < 0)
              return json(400, { error: "Invalid terminal selection." });
            const output = await hostTerminalOutput(id.data, cursor, allowed);
            return output ? json(200, output) : json(404, { error: "This terminal is unavailable." });
          }
        }
        if (req.method === "POST" && url.pathname === "/api/terminal/input") {
          const input = terminalInput.safeParse(await mutation());
          if (!input.success) return json(400, { error: "Invalid terminal input." });
          return await writeHostTerminal(input.data.terminal, input.data.input, allowed)
            ? json(202, {}) : json(404, { error: "This terminal is unavailable." });
        }
      }
      if (browser && req.method === "GET") {
        if (req.url === "/browser.js") return text(200, browserScript, "text/javascript");
        if (req.url === "/api/browser")
          return json(200, { view: await browser.execute({ action: "list" }), csrf: session.csrf });
        if (url.pathname === "/api/browser/view") {
          const action = hostBrowserInput.safeParse({ action: "view", tab: url.searchParams.get("tab") });
          return action.success
            ? json(200, { view: await browser.execute(action.data) })
            : json(400, { error: "Choose a shared tab." });
        }
      }
      if (browser && req.method === "POST" && req.url === "/api/browser/action") {
        const action = hostBrowserInput.safeParse(await mutation());
        return action.success
          ? json(200, { view: await browser.execute(action.data) })
          : json(400, { error: "Invalid Browser action." });
      }
    } catch (error) {
      if (error instanceof HostChatError) return json(error.status, { error: error.message });
      return json(500, { error: "The host could not open this item." });
    }
    res.writeHead(404).end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const binding = server.address();
  if (!binding || typeof binding === "string") throw Error("Unable to read the Host listener address.");
  origin = new URL(`https://${hostname}:${binding.port}`);
  try {
    await browser?.start();
  } catch (error) {
    server.close();
    server.closeAllConnections();
    await browser?.close();
    throw error;
  }
  return {
    url: origin.origin,
    close: () => new Promise<void>((resolve, reject) => {
      sessions.clear();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }).finally(async () => { await Promise.all([chat?.close(), maker?.close(), browser?.close()]); }),
  };
}

export async function configuredOrvaneHost(
  recent: HostOptions["recent"],
  createChat: (projects: string[], approvals: boolean) => HostAgentChat,
  createMaker?: () => UiMakerService,
) {
  if (process.env.ORVANE_HOST_ENABLED !== "1") return;
  const { ORVANE_HOST_BIND, ORVANE_HOST_NAME, ORVANE_HOST_CERT, ORVANE_HOST_KEY, ORVANE_HOST_VERIFIER } = process.env;
  if (!ORVANE_HOST_BIND || !ORVANE_HOST_CERT || !ORVANE_HOST_KEY || !ORVANE_HOST_VERIFIER)
    throw Error("Host requires a bind address, TLS certificate and key, and a password verifier.");
  const [cert, key, verifier] = await Promise.all([
    readFile(ORVANE_HOST_CERT), readFile(ORVANE_HOST_KEY), readFile(ORVANE_HOST_VERIFIER, "utf8"),
  ]);
  const projects = process.env.ORVANE_HOST_PROJECTS;
  return startOrvaneHost({
    address: ORVANE_HOST_BIND,
    hostname: ORVANE_HOST_NAME,
    port: Number(process.env.ORVANE_HOST_PORT || 8443),
    tls: { cert, key },
    verifier: verifier.trim(),
    recent,
    chat: projects ? createChat(hostProjectList.parse(JSON.parse(projects)), process.env.ORVANE_HOST_APPROVALS === "1") : undefined,
    maker: process.env.ORVANE_HOST_UI_MAKER === "1" ? createMaker?.() : undefined,
    terminal: process.env.ORVANE_HOST_TERMINAL === "1",
  });
}
