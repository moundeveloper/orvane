import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// The owner's design method (server/design-guide/, written as a SKILL.md so it
// can also be copied into a Claude or Codex skills folder). Every AI connected
// to Orvane reads it through design_guide; UI Maker tools attach it once per
// connection when it was not read yet, so design work always starts from it.

const GUIDE = fileURLToPath(new URL("./design-guide/", import.meta.url));
const TOPICS = {
  method: "SKILL.md",
  look: "reference/look.md",
  motion: "reference/motion.md",
  research: "reference/research.md",
  taste: "reference/taste-log.md",
  flow: "reference/flow-review.md",
} as const;
type Topic = keyof typeof TOPICS;
const providers = ["claude", "codex", "other"] as const;
type Provider = (typeof providers)[number];
type Guide = "standard" | "guided";

/** Approved designs in design-guide/examples: <name>.html and <name>.png. */
export const DESIGN_EXAMPLES: Record<string, string> = {
  "composer-glass": "AI prompt on frost glass over a working canvas: chips and send inside the field, model and folder pills",
  "thinking-trail": "Run as a story: step trail with one muted detail line, file chips, shimmering current step (its orb was later replaced by the DNA loader)",
  "step-details": "Picked: run activity steps that expand inline to input, output and duration, with the drawn tick",
  "drawn-tick": "Picked: done mark that draws itself, instead of strikethrough",
  "dna-loader": "Working indicator round; the DNA helix variant is the picked one (live version: .cs-dna in AgentSessions.vue)",
  "slash-skills": "Slash menu in the composer: sections, mono names, faint descriptions, kbd footer, recent-skill chips",
  "effort-modes": "Composer pills for effort and edit mode, effort slider popover with notches and a Recommended note",
  "run-changes": "Files changed card: A/M/D badges, deltas, change bars, inline diff with an Ask about this change field",
  "message-actions": "Hover toolbar on a message and a searchable action menu with shortcuts",
  "session-timeline": "Session overview on a time rail with typed colored events and a segmented filter",
  "node-library": "Workflow canvas with a searchable step library (Favourites, Triggers, Actions, Custom tools)",
  "action-menu": "Dock right-click menu with search, sections and shortcut hints",
  "create-menu": "Dock + menu: searchable app kinds with number keys, library and recently closed",
  "day-rail": "Today's triggers on a vertical time rail with a now line and Run now on failures",
  "run-plan": "Automation run history: one lane per workflow, runs as bars, failure details",
  "folder-cards": "File Explorer card view: folders show their newest files as peeking sheets, Git/SDF badges",
  "inbox-triage": "Inbox rows grouped by day, the selected one expanded with one key per action",
  "radial-glow-blend": "Picked radial wheel: Halo glow on frosted glass, outer ring fades gradually into the centre",
};

async function method(guide: Guide) {
  const shared = await readFile(join(GUIDE, TOPICS.method), "utf8");
  if (guide === "standard") return shared;
  const worksheet = await readFile(join(GUIDE, "reference/guided-mock-workflow.md"), "utf8");
  return `${shared.trimEnd()}\n\n${worksheet}`;
}

async function readDesignGuide(args: { topic?: Topic; example?: string; show?: string[] }, guide: Guide) {
  type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
  const text = (value: string): Content => ({ type: "text", text: value });
  const png = async (name: string): Promise<Content> => ({
    type: "image",
    data: (await readFile(join(GUIDE, "examples", `${name}.png`))).toString("base64"),
    mimeType: "image/png",
  });
  const known = (name: string) => {
    if (!DESIGN_EXAMPLES[name]) throw Error(`Unknown example. Available: ${Object.keys(DESIGN_EXAMPLES).join(", ")}`);
  };
  const content: Content[] = [];
  if (args.topic) {
    content.push(text(args.topic === "method" ? await method(guide) : await readFile(join(GUIDE, TOPICS[args.topic]), "utf8")));
  }
  if (args.example) {
    known(args.example);
    content.push(
      text(`Example ${args.example}: ${DESIGN_EXAMPLES[args.example]}\n\n${await readFile(join(GUIDE, "examples", `${args.example}.html`), "utf8")}`),
      await png(args.example),
    );
  }
  for (const name of args.show ?? []) {
    known(name);
    content.push(text(`${name}: ${DESIGN_EXAMPLES[name]}`), await png(name));
  }
  if (!content.length) content.push(text(await overview(guide)));
  return content;
}

async function overview(guide: Guide) {
  return [
    await method(guide),
    "## design_guide calls",
    `- topic: ${Object.keys(TOPICS).join(" | ")}`,
    "- example: one name below → its HTML and render",
    "- show: up to 8 names → renders only, for a quick look",
    "",
    "## Examples",
    ...Object.entries(DESIGN_EXAMPLES).map(([name, about]) => `- ${name}: ${about}`),
  ].join("\n");
}

export function registerDesignTools(server: McpServer) {
  const read = new Set<Guide>();
  function guideFor(provider?: Provider): Guide {
    if (provider) return provider === "claude" ? "standard" : "guided";
    const client = server.server.getClientVersion()?.name.trim().toLowerCase() ?? "";
    return /^claude(?:$|[-_\s])/.test(client) ? "standard" : "guided";
  }

  server.registerTool(
    "design_guide",
    {
      description:
        "The Orvane owner's design method: how approved designs were made (board research, translation into Orvane's soft light look, reuse of established parts, Lab variants with real content), tokens and CSS recipes, motion rules, the owner's past picks and rejections, and approved examples with renders. Read it before UI or design work. No arguments: the method for your MCP client and the example list. Claude gets the shared method. Codex and other clients also get the guided mock workflow. Pass provider to override the client identity when using a proxy. topic: method | look | motion | research | taste | flow. example: one name (HTML + render). show: up to 8 example names (renders).",
      inputSchema: {
        topic: z.enum(Object.keys(TOPICS) as [Topic, ...Topic[]]).optional(),
        provider: z.enum(providers).optional().describe("Optional provider override when the MCP client name does not identify the model provider."),
        example: z.string().max(60).optional(),
        show: z.array(z.string().max(60)).max(8).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ provider, ...args }) => {
      try {
        const guide = guideFor(provider);
        const content = await readDesignGuide(args, guide);
        if (args.topic === "method" || (!args.topic && !args.example && !args.show?.length)) read.add(guide);
        return { content };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  );
  server.registerPrompt(
    "design",
    {
      title: "Design with Orvane's method",
      description: "Design or redesign UI following the owner's design method (research, look, motion, Lab variants).",
      argsSchema: { task: z.string().optional() },
    },
    async ({ task }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `${task ? `Design task: ${task}\n\n` : ""}Follow the Orvane design method. Start by calling design_guide (no arguments), then topics look and motion, and look at the examples that are closest to this task. Work in UI Maker Lab unless I say otherwise.`,
          },
        },
      ],
    }),
  );

  // UI Maker also provides the connection's method on the first design action.
  return async function designGuideOnce() {
    const guide = guideFor();
    if (read.has(guide)) return [];
    read.add(guide);
    try {
      return [{
        type: "text" as const,
        text: `Before designing, follow the owner's design method below. Read design_guide topics look and motion, and inspect the closest approved examples before writing HTML.\n\n${await overview(guide)}`,
      }];
    } catch (error) {
      read.delete(guide);
      throw error;
    }
  };
}
