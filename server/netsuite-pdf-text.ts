import { inflateSync } from "node:zlib";

// Best-effort PDF text layer extraction without a parser dependency. Based on
// Magic NetSuite's fallback (Tj/TJ string operators), plus FlateDecode content
// streams, compressed object streams and fonts' ToUnicode maps (embedded
// subset fonts, as NetSuite's Advanced PDF output uses). Scanned PDFs and fonts
// without a ToUnicode map come out empty; callers report that.

type ToUnicode = { bytes: number; map: Map<number, string> };

function utf16(bytes: Buffer, from = 0) {
  let text = "";
  for (let i = from; i + 1 < bytes.length; i += 2) text += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
  return text;
}
/** A literal string's bytes (escapes resolved), as a latin1 string. */
function literalBytes(value: string) {
  let output = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char !== "\\") {
      output += char;
      continue;
    }
    const next = value[++i] ?? "";
    if (next === "n") output += "\n";
    else if (next === "r") output += "\r";
    else if (next === "t") output += "\t";
    else if (next === "b") output += "\b";
    else if (next === "f") output += "\f";
    else if (/[0-7]/.test(next)) {
      let octal = next;
      for (let j = 0; j < 2 && /[0-7]/.test(value[i + 1] ?? ""); j++) octal += value[++i];
      output += String.fromCharCode(parseInt(octal, 8) & 0xff);
    } else if (next === "\n" || next === "\r") continue;
    else output += next;
  }
  return output;
}
function hexBytes(value: string) {
  const clean = value.replace(/\s+/g, "");
  return Buffer.from(clean.length % 2 ? clean + "0" : clean, "hex").toString("latin1");
}
function decodeString(raw: string, font?: ToUnicode) {
  const bytes = Buffer.from(raw, "latin1");
  if (font) {
    let text = "";
    for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
      const code = font.bytes === 2 ? (bytes[i]! << 8) | bytes[i + 1]! : bytes[i]!;
      text += font.map.get(code) ?? (font.bytes === 1 ? String.fromCharCode(code) : "");
    }
    return text;
  }
  return bytes[0] === 0xfe && bytes[1] === 0xff ? utf16(bytes, 2) : raw;
}
const hexValue = (hex: string) => Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex");
/** Parses bfchar/bfrange entries of a ToUnicode CMap. */
export function parseToUnicode(cmap: string): ToUnicode {
  const map = new Map<number, string>();
  const space = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(cmap);
  const bytes = space ? Math.max(1, Math.min(2, space[1]!.length / 2)) : 2;
  const code = (hex: string) => parseInt(hex, 16);
  const target = (hex: string) => utf16(hexValue(hex.replace(/\s+/g, "")));
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const [, from, to] of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f\s]*)>/gi)) map.set(code(from!), target(to!));
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const [, from, to, rest] of block[1]!.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<[0-9a-f\s]*>|\[[^\]]*\])/gi)) {
      const start = code(from!),
        end = Math.min(code(to!), start + 65535);
      if (rest!.startsWith("[")) {
        const items = [...rest!.matchAll(/<([0-9a-f\s]*)>/gi)].map((item) => target(item[1]!));
        items.forEach((value, index) => start + index <= end && map.set(start + index, value));
      } else {
        const base = hexValue(rest!.slice(1, -1).replace(/\s+/g, ""));
        for (let value = start; value <= end; value++) {
          const next = Buffer.from(base);
          next.writeUInt16BE((next.readUInt16BE(next.length - 2) + value - start) & 0xffff, next.length - 2);
          map.set(value, utf16(next));
        }
      }
    }
  return { bytes, map };
}

function textOperators(source: string, fonts: Map<string, ToUnicode>) {
  const chunks: string[] = [];
  const token = /\/([^\s/<>\[\]()]+)\s+-?[\d.]+\s+Tf|\(((?:\\[\s\S]|[^\\)])*)\)\s*(?:Tj|'|")|<([0-9A-Fa-f\s]+)>\s*Tj|\[((?:[^\]\\]|\\[\s\S])*)\]\s*TJ|(T\*|ET|-?[\d.]+\s+-?[\d.]+\s+T[dD])/g;
  let match,
    font: ToUnicode | undefined;
  while ((match = token.exec(source))) {
    if (match[1] !== undefined) font = fonts.get(match[1]);
    else if (match[2] !== undefined) chunks.push(decodeString(literalBytes(match[2]), font));
    else if (match[3] !== undefined) chunks.push(decodeString(hexBytes(match[3]), font));
    else if (match[4] !== undefined) {
      const part = /\(((?:\\[\s\S]|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>|(-?\d+(?:\.\d+)?)/g;
      let piece,
        line = "";
      while ((piece = part.exec(match[4]))) {
        if (piece[1] !== undefined) line += decodeString(literalBytes(piece[1]), font);
        else if (piece[2] !== undefined) line += decodeString(hexBytes(piece[2]), font);
        else if (Number(piece[3]) < -200) line += " ";
      }
      chunks.push(line);
    } else if (/T[dD]$/.test(match[5]!)) {
      // A move to a new line starts a new line; a move along the same line adds a space.
      chunks.push(Number(match[5]!.trim().split(/\s+/)[1]) !== 0 ? "\n" : " ");
    } else chunks.push("\n");
  }
  return chunks.join("");
}
export function normalizePdfText(text: string) {
  return text
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Every object's dictionary text and decoded stream, including objects inside compressed object streams. */
function readObjects(source: string) {
  const objects = new Map<number, { dict: string; stream?: string }>();
  const header = /(\d+)\s+\d+\s+obj\b/g;
  let match,
    budget = 30_000_000;
  const decode = (dict: string, raw: string) => {
    if (/\/Filter\s*(\[\s*)?\/FlateDecode/.test(dict)) {
      try {
        return inflateSync(Buffer.from(raw, "latin1"), { maxOutputLength: 10_000_000 }).toString("latin1");
      } catch {
        return undefined;
      }
    }
    return /\/Filter/.test(dict) ? undefined : raw;
  };
  while ((match = header.exec(source)) && budget > 0) {
    const bodyStart = match.index + match[0].length;
    const streamAt = source.indexOf("stream", bodyStart);
    const endObj = source.indexOf("endobj", bodyStart);
    if (endObj < 0) break;
    if (streamAt >= 0 && streamAt < endObj && !source.startsWith("endstream", streamAt - 3)) {
      const dict = source.slice(bodyStart, streamAt);
      const dataStart = streamAt + 6 + (source[streamAt + 6] === "\r" ? 2 : 1);
      const end = source.indexOf("endstream", dataStart);
      if (end < 0) break;
      header.lastIndex = end;
      // Skip images and embedded font programs.
      if (/\/Subtype\s*\/Image|\/Length[123]\b|\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)/.test(dict)) continue;
      const stream = decode(dict, source.slice(dataStart, end));
      budget -= stream?.length ?? 0;
      objects.set(Number(match[1]), { dict, stream });
      if (stream && /\/Type\s*\/ObjStm/.test(dict)) {
        const count = Number(/\/N\s+(\d+)/.exec(dict)?.[1] ?? 0),
          first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? 0);
        const pairs = stream.slice(0, first).trim().split(/\s+/).map(Number);
        for (let i = 0; i < Math.min(count, pairs.length / 2); i++) {
          const from = first + pairs[i * 2 + 1]!,
            to = i + 1 < count ? first + pairs[i * 2 + 3]! : stream.length;
          objects.set(pairs[i * 2]!, { dict: stream.slice(from, to) });
        }
      }
    } else {
      objects.set(Number(match[1]), { dict: source.slice(bodyStart, endObj) });
      header.lastIndex = endObj;
    }
  }
  return objects;
}

export function extractPdfText(buffer: Buffer) {
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return { text: "", pageCount: 0 };
  const source = buffer.toString("latin1");
  const objects = readObjects(source);
  const dicts = [...objects.values()].map((object) => object.dict);
  const pageCount = dicts.filter((dict) => /\/Type\s*\/Page(?![a-z])/i.test(dict)).length;
  // Font resource names (/F1…) → ToUnicode maps. Names are merged across pages: best effort.
  const fonts = new Map<string, ToUnicode>();
  const fontFor = (id: number) => {
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(objects.get(id)?.dict ?? "");
    const cmap = ref ? objects.get(Number(ref[1]))?.stream : undefined;
    return cmap ? parseToUnicode(cmap) : undefined;
  };
  const addFonts = (entries: string) => {
    for (const [, name, id] of entries.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      const font = fontFor(Number(id));
      if (font && !fonts.has(name!)) fonts.set(name!, font);
    }
  };
  for (const dict of dicts) {
    for (const inline of dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) addFonts(inline[1]!);
    for (const ref of dict.matchAll(/\/Font\s+(\d+)\s+\d+\s+R/g)) addFonts(objects.get(Number(ref[1]))?.dict ?? "");
  }
  const parts: string[] = [];
  for (const object of objects.values()) {
    if (!object.stream || /\/Type\s*\/(ObjStm|XRef|Metadata)|\/Subtype\s*\/XML/.test(object.dict) || /begincmap/.test(object.stream)) continue;
    const text = textOperators(object.stream, fonts);
    if (text.trim()) parts.push(text);
  }
  if (!parts.length) parts.push(textOperators(source, fonts));
  const text = normalizePdfText(parts.join("\n"));
  // Mostly unprintable output means a font without a usable ToUnicode map.
  const printable = text.replace(/[^\p{L}\p{N}\p{P}\p{S}\p{Zs}\n]/gu, "").length;
  return { text: text && printable / text.length > 0.8 ? text : "", pageCount };
}
