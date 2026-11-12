import { z } from "zod";
const text = z.string().min(1).max(2000);
const id = z.string().min(1).max(200);
const base = { id, title: text, detail: z.boolean().optional() };
const identity = z
  .object({
    ...base,
    type: z.literal("identity"),
    owners: z
      .array(
        z.object({ name: text, field: text, label: text, active: z.boolean() }),
      )
      .length(2),
  })
  .refine(
    (v) => v.owners.filter((o) => o.active).length === 1,
    "Exactly one owner must be the active source.",
  );
const allocation = z
  .object({
    ...base,
    type: z.literal("allocation"),
    total: z.number().positive().finite(),
    consumed: z.number().positive().finite(),
    part: z.number().nonnegative().finite(),
    label: text,
    approximate: z.boolean().default(false),
  })
  .refine(
    (v) => v.part <= v.consumed && v.consumed <= v.total,
    "Require part ≤ consumed ≤ total.",
  );
const recovery = z.object({
  ...base,
  type: z.literal("recovery"),
  batch: text,
  next: text,
  cadence: text,
  retriesAvailable: z.boolean().default(true),
});
const checks = z
  .object({
    ...base,
    type: z.literal("checks"),
    available: z.array(id).max(30),
    checks: z
      .array(
        z.object({
          id,
          name: text,
          requires: z.array(id).max(12),
          finding: text.optional(),
        }),
      )
      .min(1)
      .max(20),
  })
  .refine(
    (v) => new Set(v.checks.map((c) => c.id)).size === v.checks.length,
    "Check IDs must be unique.",
  );
const flow = z
  .object({
    ...base,
    type: z.literal("flow"),
    nodes: z
      .array(
        z.object({
          id,
          title: text,
          lines: z.array(text).max(15).default([]),
          code: z.string().max(6000).optional(),
        }),
      )
      .min(1)
      .max(20),
    edges: z.array(z.object({ from: id, to: id, label: text })).max(30),
  })
  .refine(
    (v) =>
      new Set(v.nodes.map((n) => n.id)).size === v.nodes.length &&
      v.edges.every(
        (e) =>
          v.nodes.some((n) => n.id === e.from) &&
          v.nodes.some((n) => n.id === e.to),
      ),
    "Flow nodes must be unique and all edge endpoints must exist.",
  );
const comparison = z.object({
  ...base,
  type: z.literal("comparison"),
  left: text,
  right: text,
  rows: z
    .array(z.object({ label: text, left: text, right: text }))
    .min(1)
    .max(40),
});
const routeSteps = z
  .array(z.object({ title: text, note: text.optional() }))
  .min(1)
  .max(4);
const routes = z.object({
  ...base,
  type: z.literal("routes"),
  lanes: z
    .array(z.object({ label: text, steps: routeSteps }))
    .min(2)
    .max(3),
  merge: text,
  shared: routeSteps,
  exception: z.object({ title: text, note: text }).optional(),
});
const sequence = z
  .object({
    ...base,
    type: z.literal("sequence"),
    participants: z
      .array(z.object({ id, name: text }))
      .min(2)
      .max(12),
    messages: z
      .array(
        z.object({
          from: id,
          to: id,
          label: text,
          reply: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(60),
  })
  .refine(
    (v) =>
      new Set(v.participants.map((p) => p.id)).size === v.participants.length &&
      v.messages.every(
        (m) =>
          v.participants.some((p) => p.id === m.from) &&
          v.participants.some((p) => p.id === m.to),
      ),
    "Sequence endpoints must name unique participants.",
  );
export const expositionPartSchema = z.union([
  identity,
  allocation,
  recovery,
  checks,
  flow,
  routes,
  comparison,
  sequence,
]);
export const expositionSchema = z
  .object({
    id,
    title: text,
    summary: z.string().max(2000).default(""),
    status: z.enum(["illustrative", "historical", "proposal", "verified"]),
    sources: z.array(text).max(20).default([]),
    parts: z.array(expositionPartSchema).min(1).max(12),
  })
  .refine(
    (v) => new Set(v.parts.map((p) => p.id)).size === v.parts.length,
    "Part IDs must be unique.",
  )
  .refine(
    (v) => v.status !== "verified" || v.sources.length > 0,
    "Verified explanations need source references.",
  );
export type ExpositionPart = z.infer<typeof expositionPartSchema>;
export type Exposition = z.infer<typeof expositionSchema>;
export interface VisualRecord {
  view: Exposition;
  sessionKey: string;
  anchorId: string | null;
  revision: number;
  updatedAt: number;
}
export interface ClaudeSession {
  key: string;
  sessionId: string;
  title: string;
  project: string;
  updatedAt: number;
  bytes: number;
}
export interface ClaudeMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  tools: { id: string; name: string; visualId?: string }[];
  truncated: boolean;
}
export interface ClaudeRead {
  session: ClaudeSession;
  messages: ClaudeMessage[];
  before: string | null;
  warnings: string[];
  visuals: VisualRecord[];
}
export async function claudeRequest<T>(
  operation: string,
  args: unknown = {},
): Promise<T> {
  const response = await fetch(`/__orvane/claude/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
        ? data.error
        : "Claude sessions could not be read.",
    );
  return data as T;
}
