import type { InjectionKey } from "vue";

export const RECORD_PREVIEW_MIME = "application/x-orvane-netsuite-preview";
export type RecordPreviewLink = {
  sourceBlockId: string;
  queryId: string;
  queryName: string;
  columns: string[];
  column: string;
  type: string;
};
export type SuiteQLSelection = {
  owner: symbol;
  environment: string;
  row: Record<string, unknown>;
};
export const querySource = (blockId: string, queryId: string) =>
  JSON.stringify([blockId, queryId]);
export const recordTypePattern = /^[a-z][a-z0-9_]{0,99}$/;
export function readRecordPreview(
  value: string,
): RecordPreviewLink | undefined {
  try {
    const link = JSON.parse(value);
    if (
      typeof link?.sourceBlockId === "string" &&
      link.sourceBlockId &&
      typeof link.queryId === "string" &&
      link.queryId &&
      typeof link.queryName === "string" &&
      typeof link.column === "string" &&
      typeof link.type === "string" &&
      (!link.type || recordTypePattern.test(link.type)) &&
      Array.isArray(link.columns) &&
      link.columns.every((column: unknown) => typeof column === "string")
    )
      return link;
  } catch {
    // Blank or invalid widget configuration.
  }
}

export const netSuiteCanvas: InjectionKey<{
  editable: () => boolean;
  sourceExists: (blockId: string, queryId: string) => boolean;
  hasPreview: (source: string) => boolean;
  selections: Map<string, SuiteQLSelection>;
  addPreview: (link: RecordPreviewLink, at?: { x: number; y: number }) => void;
}> = Symbol("NetSuite canvas");
