// Read-only spreadsheet reading for File Explorer peek: .xlsx/.xlsm through a
// minimal ZIP reader (node:zlib) and XML scan, .csv/.tsv through a small
// RFC 4180 parser. No third-party dependency; values are shown as stored.
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";

const FILE_LIMIT = 40_000_000;
const ROW_LIMIT = 2000;
const COL_LIMIT = 80;
export type Sheet = { names: string[]; index: number; rows: string[][]; truncated: boolean };

function unzip(buffer: Buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("This is not a readable Excel workbook.");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, () => Buffer>();
  for (let n = 0; n < count && offset + 46 <= buffer.length; n++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10),
      size = buffer.readUInt32LE(offset + 20),
      nameLength = buffer.readUInt16LE(offset + 28),
      extra = buffer.readUInt16LE(offset + 30),
      comment = buffer.readUInt16LE(offset + 32),
      local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 200_000_000 });
      throw new Error("This workbook uses an unsupported compression.");
    });
    offset += 46 + nameLength + extra + comment;
  }
  return (name: string) => entries.get(name)?.().toString("utf8");
}
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decode(text: string) {
  return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (match, code: string) =>
    code[0] === "#"
      ? String.fromCodePoint(code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)))
      : (ENTITIES[code] ?? match),
  );
}
// Rich-text runs hold several <t> pieces; phonetic hints (<rPh>) are skipped.
function textOf(xml: string) {
  return decode(
    [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""),
  );
}
function column(ref: string) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}
function xlsx(buffer: Buffer, wanted: number): Sheet {
  const read = unzip(buffer);
  const workbook = read("xl/workbook.xml");
  if (!workbook) throw new Error("This is not a readable Excel workbook.");
  const rels = read("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1],
      target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: decode(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? "Sheet"),
    target: targets.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "",
  }));
  if (!sheets.length) throw new Error("The workbook has no sheets.");
  const index = Math.min(Math.max(0, wanted), sheets.length - 1);
  const shared = [...(read("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const xml = read(sheets[index]!.target) ?? "";
  const rows: string[][] = [];
  let truncated = false;
  for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const r = Number(/\br="(\d+)"/.exec(row[1]!)?.[1] ?? rows.length + 1) - 1;
    if (r >= ROW_LIMIT) {
      truncated = true;
      break;
    }
    const cells: string[] = (rows[r] = []);
    for (const cell of row[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]!,
        body = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const c = ref ? column(ref) : cells.length;
      if (c >= COL_LIMIT) {
        truncated = true;
        continue;
      }
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      cells[c] =
        type === "s"
          ? (shared[Number(v)] ?? "")
          : type === "inlineStr"
            ? textOf(body)
            : type === "b"
              ? v === "1" ? "TRUE" : "FALSE"
              : decode(v ?? "");
    }
  }
  for (let i = 0; i < rows.length; i++) rows[i] = Array.from(rows[i] ?? [], (v) => v ?? "");
  return { names: sheets.map((s) => s.name), index, rows, truncated };
}
function delimited(text: string, separator: string): Sheet {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    truncated = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && !field) quoted = true;
    else if (ch === separator) row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row.slice(0, COL_LIMIT));
      (row = []), (field = "");
      if (rows.length >= ROW_LIMIT) {
        truncated = i < text.length - 1;
        break;
      }
    } else field += ch;
  }
  if ((field || row.length) && rows.length < ROW_LIMIT) rows.push([...row, field].slice(0, COL_LIMIT));
  return { names: ["Sheet"], index: 0, rows, truncated };
}
export async function readSheet(path: string, index = 0): Promise<Sheet> {
  const info = await stat(path);
  if (info.size > FILE_LIMIT) throw new Error("The spreadsheet is too large to preview.");
  const ext = extname(path).toLowerCase();
  const buffer = await readFile(path);
  if (ext === ".xlsx" || ext === ".xlsm") return xlsx(buffer, index);
  if (ext === ".csv" || ext === ".tsv") {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    const sample = text.slice(0, 4000);
    const separator =
      ext === ".tsv" ? "\t" : (sample.match(/;/g)?.length ?? 0) > (sample.match(/,/g)?.length ?? 0) ? ";" : ",";
    return delimited(text, separator);
  }
  throw new Error("Only .xlsx, .xlsm, .csv and .tsv spreadsheets can be previewed.");
}
