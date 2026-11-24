import { z } from "zod";

const tab = z.string().min(1).max(200);
const url = z.url({ protocol: /^https?$/ }).max(2500);
const fraction = z.number().finite().min(0).max(1);
export const hostBrowserInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("open"), url }),
  z.strictObject({ action: z.literal("select"), tab }),
  z.strictObject({ action: z.literal("view"), tab }),
  z.strictObject({ action: z.literal("navigate"), tab, url }),
  z.strictObject({ action: z.enum(["back", "forward", "reload"]), tab }),
  z.strictObject({ action: z.literal("click"), tab, x: fraction, y: fraction, page: url }),
  z.strictObject({ action: z.literal("scroll"), tab, x: fraction, y: fraction, dy: z.number().finite().min(-1500).max(1500), page: url }),
  z.strictObject({ action: z.literal("text"), tab, value: z.string().min(1).max(4000), page: url }),
  z.strictObject({
    action: z.literal("key"), tab, page: url,
    key: z.enum(["Enter", "Escape", "Tab", "Backspace", "Control+a", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]),
  }),
]);
export type HostBrowserInput = z.infer<typeof hostBrowserInput>;
