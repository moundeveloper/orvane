// Shortened tool inputs and outputs for the step lists in Agent sessions,
// shared by live runs and transcript reading.
// Step details travel with every run update, so keep them short.
const stepInputLimit = 2_000;
const stepOutputLimit = 2_000;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** Tool arguments as display strings, within stepInputLimit in total. */
export function stepInput(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input: Record<string, string> = {};
  let room = stepInputLimit;
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (room <= 0) break;
    const text =
      typeof item === "string" ? item : (JSON.stringify(item, null, 2) ?? "");
    input[key.slice(0, 80)] = clip(text, room);
    room -= text.length;
  }
  return Object.keys(input).length ? input : undefined;
}

/** Text of a tool result: a string, or an array of content blocks. */
export function stepOutput(content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              typeof block?.text === "string"
                ? block.text
                : block?.type === "image"
                  ? "[image]"
                  : "",
            )
            .filter(Boolean)
            .join("\n")
        : content && typeof content === "object"
          ? JSON.stringify(content, null, 2)
          : "";
  return text ? clip(text, stepOutputLimit) : undefined;
}
