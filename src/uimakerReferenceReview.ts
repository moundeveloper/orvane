import { z } from "zod";

export const referenceSource = z.url({ protocol: /^https$/ }).max(1500);
export const referenceCandidate = z.object({
  source: referenceSource,
  title: z.string().min(1).max(100),
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: z.string().min(1).max(2_666_668),
}).strict();

export const referenceReviewRequest = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("propose"),
    id: z.uuid(),
    replaces: z.uuid().optional(),
    candidates: z.array(referenceCandidate).min(1).max(6),
  }).strict(),
  z.object({ action: z.literal("status"), id: z.uuid() }).strict(),
]);

export type ReferenceCandidate = z.infer<typeof referenceCandidate>;
export type ReferenceReviewRequest = z.infer<typeof referenceReviewRequest>;
export type ReferenceReviewResult =
  | { id: string; status: "pending" }
  | { id: string; status: "accepted"; selected: string[] }
  | { id: string; status: "alternatives-requested"; feedback: string; exclude: string[]; replacement?: string };
