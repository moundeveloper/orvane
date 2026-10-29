export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulleted"
  | "numbered"
  | "todo"
  | "toggle"
  | "quote"
  | "callout"
  | "divider"
  | "code"
  | "image";

export interface Block {
  id: string;
  pageId: string;
  type: BlockType;
  /** rich text HTML for text blocks; data URL for image; raw text for code */
  html: string;
  indent: number;
  position: number;
  checked?: boolean;
  collapsed?: boolean;
  icon?: string;
  lang?: string;
  caption?: string;
  /** percentage of the available editor width used by an image block */
  imageWidth?: number;
  createdAt: string;
  updatedAt: string;
}

export type PageType = "page" | "database";

export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multiselect"
  | "checkbox"
  | "date"
  | "url"
  | "email"
  | "phone";

export interface DbProperty {
  id: string;
  name: string;
  type: PropertyType;
  options?: { id: string; name: string; color: string }[];
}

export type FilterOp =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "lt";

export interface DbFilter {
  id: string;
  propertyId: string;
  op: FilterOp;
  value: string;
}

export interface DbSort {
  id: string;
  propertyId: string;
  direction: "asc" | "desc";
}

export type DbViewType = "table" | "board" | "list";

export interface DbView {
  id: string;
  name: string;
  type: DbViewType;
  groupBy?: string;
  filters: DbFilter[];
  filterMode: "and" | "or";
  sorts: DbSort[];
  hiddenProps?: string[];
}

export interface DbSchema {
  properties: DbProperty[];
  views: DbView[];
}

export interface Page {
  id: string;
  parentId: string | null;
  type: PageType;
  title: string;
  icon: string | null;
  isFavorite: boolean;
  trashedAt: string | null;
  position: number;
  dbSchema?: DbSchema;
  /** record property values when parent is a database: propId -> value */
  values?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  key: string;
  value: unknown;
}
