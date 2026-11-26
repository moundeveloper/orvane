import { z } from "zod";

const runId = z.uuid();
const message = z.string().trim().min(1).max(12_000);

export const agentDelegationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("start"),
    requestId: runId,
    provider: z.enum(["claude", "codex"]),
    folder: z.string().min(1).max(2000),
    message,
    model: z.string().max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).optional(),
    effort: z.enum(["low", "medium", "high", "max"]).optional(),
    mode: z.enum(["ask", "auto", "plan", "full"]).optional(),
    sourceSessionKey: z.string().min(1).max(1000).optional(),
  }),
  z.strictObject({ action: z.literal("status"), runId }),
  z.strictObject({
    action: z.literal("follow_up"),
    runId,
    requestId: runId,
    message,
  }),
  z.strictObject({ action: z.literal("stop"), runId }),
]);

export type AgentDelegationInput = z.infer<typeof agentDelegationSchema>;
