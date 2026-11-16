import { z } from "zod";
import { IMAGE_ID } from "./imageId.ts";

export const INBOX_LIMIT = 100;
export const CAPTURE_TEXT_LIMIT = 20_000;
const captureBase = {
  id: z.string().min(1).max(200),
  capturedAt: z.number().int().nonnegative().max(8.64e15),
};
export const captureSchema = z.discriminatedUnion("kind", [
  z.object({
    ...captureBase,
    kind: z.literal("text"),
    value: z.string().min(1).max(CAPTURE_TEXT_LIMIT),
  }),
  z.object({
    ...captureBase,
    kind: z.literal("image"),
    value: z.string().regex(IMAGE_ID),
  }),
]);
export type InboxCapture = z.infer<typeof captureSchema>;
export type ClipboardCapture = { kind: "text" | "image"; value: string };

export function captureLink(value: string) {
  if (!/^https?:\/\/\S+$/i.test(value) || value.length > 4000) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
