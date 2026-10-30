import { Parser } from "node-sql-parser/build/mysql";

export type SuiteQLTraceStageKind = "subquery" | "source" | "join" | "final";

export type SuiteQLTraceStageStatus =
  "pending" | "running" | "success" | "error" | "skipped";

export interface SuiteQLTraceStage {
  id: string;
  sequence: number;
  kind: SuiteQLTraceStageKind;
  title: string;
  description: string;
  sql: string;
  status: SuiteQLTraceStageStatus;
  inputStageIds: string[];
  aliases: string[];
  rowCount: number | null;
  rows: Record<string, any>[];
  columns: string[];
  error: string;
  executable: boolean;
  note?: string;
}

export interface SuiteQLTracePlan {
  sql: string;
  stages: SuiteQLTraceStage[];
  warnings: string[];
}

type SqlNode = Record<string, any>;

const parser = new Parser();
const EMPTY_LIMIT = { seperator: "", value: [] };

const normalizeGeneratedSQL = (sql: string) =>
  sql
    .replace(/`([A-Za-z_][\w$]*)`/g, "$1")
    .replace(/"([A-Za-z_][\w$]*)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const isSelect = (value: unknown): boolean =>
  Boolean(
    value &&
    typeof value === "object" &&
    String((value as SqlNode).type ?? "").toLowerCase() === "select",
  );

const identifierValue = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (!value || typeof value !== "object") return "";
  const node = value as SqlNode;
  if (typeof node.value === "string" || typeof node.value === "number") {
    return String(node.value);
  }
  return identifierValue(node.expr);
};

const sourceAlias = (source: SqlNode) =>
  String(source.as || source.table || "source");

const sourceName = (source: SqlNode) =>
  String(source.table || source.as || "derived query");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const flattenAnd = (expression: unknown): SqlNode[] => {
  if (!expression || typeof expression !== "object") return [];
  const node = expression as SqlNode;
  if (
    node.type === "binary_expr" &&
    String(node.operator).toUpperCase() === "AND"
  ) {
    return [...flattenAnd(node.left), ...flattenAnd(node.right)];
  }
  return [node];
};

const combineAnd = (expressions: SqlNode[]): SqlNode | null => {
  if (expressions.length === 0) return null;
  return expressions.slice(1).reduce<SqlNode>(
    (left, right) => ({
      type: "binary_expr",
      operator: "AND",
      left,
      right,
    }),
    clone(expressions[0]!),
  );
};

const walkWithoutNestedSelects = (
  value: unknown,
  visit: (node: SqlNode) => void,
) => {
  const seen = new WeakSet<object>();
  const walk = (current: unknown) => {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    const node = current as SqlNode;
    if (isSelect(node)) return;
    if (isSelect(node.ast)) return;
    visit(node);
    Object.values(node).forEach(walk);
  };
  walk(value);
};

const expressionAliases = (expression: unknown) => {
  const aliases = new Set<string>();
  walkWithoutNestedSelects(expression, (node) => {
    if (node.type === "column_ref" && node.table) {
      aliases.add(String(node.table).toLowerCase());
    }
  });
  return aliases;
};

const collectRelevantColumns = (
  statement: SqlNode,
  availableAliases: Set<string>,
) => {
  const columns: SqlNode[] = [];
  const seen = new Set<string>();
  const values: unknown[] = [
    statement.columns,
    statement.where,
    statement.groupby,
    statement.having,
    statement.orderby,
    ...(Array.isArray(statement.from)
      ? statement.from.map((source: SqlNode) => source.on)
      : []),
  ];

  for (const value of values) {
    walkWithoutNestedSelects(value, (node) => {
      if (node.type !== "column_ref") return;
      const alias = node.table ? String(node.table) : "";
      const field = identifierValue(node.column);
      if (!field || field === "*") return;
      if (alias && !availableAliases.has(alias.toLowerCase())) return;
      const key = `${alias.toLowerCase()}.${field.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      columns.push({
        type: "expr",
        expr: clone(node),
        as: `${alias || "value"}__${field}`,
      });
    });
  }

  return columns.length > 0
    ? columns
    : [{ type: "expr", expr: { type: "star", value: "*" }, as: null }];
};

const buildStageStatement = (
  root: SqlNode,
  sources: SqlNode[],
  predicates: SqlNode[],
) => {
  const aliases = new Set(
    sources.map(sourceAlias).map((alias) => alias.toLowerCase()),
  );
  const statement = clone(root);
  statement.with = root.with ? clone(root.with) : null;
  statement.columns = collectRelevantColumns(root, aliases);
  statement.from = clone(sources);
  statement.where = combineAnd(predicates);
  statement.groupby = null;
  statement.having = null;
  statement.orderby = null;
  statement.limit = clone(EMPTY_LIMIT);
  statement.distinct = { type: null };
  statement.window = null;
  return normalizeGeneratedSQL(parser.sqlify(statement as any));
};

const collectNestedSelects = (root: SqlNode) => {
  const results: Array<{ statement: SqlNode; label: string }> = [];
  const seen = new WeakSet<object>();
  const walk = (value: unknown, label = "Subquery") => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, label));
      return;
    }
    const node = value as SqlNode;
    if (isSelect(node) && node !== root) {
      results.push({ statement: node, label });
      return;
    }
    if (isSelect(node.ast)) {
      results.push({ statement: node.ast, label });
      return;
    }
    Object.entries(node).forEach(([key, child]) =>
      walk(child, key === "stmt" ? "CTE" : label),
    );
  };
  walk(root);
  return results;
};

const independentSubquery = (statement: SqlNode) => {
  const localAliases = new Set(
    (Array.isArray(statement.from) ? statement.from : [])
      .map(sourceAlias)
      .map((alias: string) => alias.toLowerCase()),
  );
  const referencedAliases = new Set<string>();
  [
    statement.columns,
    statement.where,
    statement.having,
    statement.groupby,
  ].forEach((value) =>
    walkWithoutNestedSelects(value, (node) => {
      if (node.type === "column_ref" && node.table) {
        referencedAliases.add(String(node.table).toLowerCase());
      }
    }),
  );
  return [...referencedAliases].every((alias) => localAliases.has(alias));
};

const stage = (
  stages: SuiteQLTraceStage[],
  value: Omit<
    SuiteQLTraceStage,
    "sequence" | "status" | "rowCount" | "rows" | "columns" | "error"
  >,
) => {
  stages.push({
    ...value,
    sequence: stages.length + 1,
    status: value.executable ? "pending" : "skipped",
    rowCount: null,
    rows: [],
    columns: [],
    error: "",
  });
};

export const createSuiteQLTracePlan = (sql: string): SuiteQLTracePlan => {
  const sourceSql = (sql ?? "").trim();
  const warnings: string[] = [];
  let parsed: SqlNode;

  try {
    const result = parser.astify(sourceSql, {
      parseOptions: { includeLocations: true },
    }) as SqlNode | SqlNode[];
    parsed = (Array.isArray(result) ? result[0] : result) as SqlNode;
  } catch (error) {
    return {
      sql: sourceSql,
      stages: [],
      warnings: [
        `The execution trace could not parse this query: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  if (!isSelect(parsed)) {
    return {
      sql: sourceSql,
      stages: [],
      warnings: ["Execution tracing is available for SELECT queries."],
    };
  }

  const stages: SuiteQLTraceStage[] = [];
  const sources = Array.isArray(parsed.from) ? (parsed.from as SqlNode[]) : [];
  const predicates = flattenAnd(parsed.where);
  const allAliases = new Set(
    sources.map(sourceAlias).map((alias) => alias.toLowerCase()),
  );

  collectNestedSelects(parsed).forEach(({ statement, label }, index) => {
    const executable = independentSubquery(statement);
    stage(stages, {
      id: `subquery-${index + 1}`,
      kind: "subquery",
      title: `${label} ${index + 1}`,
      description: executable
        ? "Runs this nested query independently before inspecting the outer query."
        : "This correlated subquery depends on an outer row and cannot be run independently.",
      sql: normalizeGeneratedSQL(parser.sqlify(statement as any)),
      inputStageIds: [],
      aliases: (Array.isArray(statement.from) ? statement.from : []).map(
        sourceAlias,
      ),
      executable,
      note: executable
        ? undefined
        : "Its result changes for each outer row; inspect the final stage to see the correlated result.",
    });
  });

  const sourceStageIds = new Map<string, string>();
  sources.forEach((rawSource, index) => {
    const alias = sourceAlias(rawSource);
    const localPredicates = predicates.filter((predicate) => {
      const refs = expressionAliases(predicate);
      if (refs.size === 0) return sources.length === 1;
      return refs.size === 1 && refs.has(alias.toLowerCase());
    });
    const isolatedSource = clone(rawSource);
    delete isolatedSource.join;
    delete isolatedSource.on;
    delete isolatedSource.using;
    const executable = Boolean(isolatedSource.table || isolatedSource.expr);
    const id = `source-${index + 1}`;
    sourceStageIds.set(alias.toLowerCase(), id);
    stage(stages, {
      id,
      kind: "source",
      title: `${sourceName(rawSource)}${alias !== sourceName(rawSource) ? ` (${alias})` : ""}`,
      description:
        localPredicates.length > 0
          ? `Reads this source with ${localPredicates.length} filter${localPredicates.length === 1 ? "" : "s"} that reference only ${alias}.`
          : "Reads this source before it is combined with the other query sources.",
      sql: executable
        ? buildStageStatement(parsed, [isolatedSource], localPredicates)
        : "",
      inputStageIds: [],
      aliases: [alias],
      executable,
    });
  });

  let previousStageId = sources[0]
    ? (sourceStageIds.get(sourceAlias(sources[0]).toLowerCase()) ?? "")
    : "";
  for (let index = 1; index < sources.length; index++) {
    const includedSources = sources.slice(0, index + 1);
    const includedAliases = new Set(
      includedSources
        .map(sourceAlias)
        .map((alias: string) => alias.toLowerCase()),
    );
    const applicablePredicates = predicates.filter((predicate) => {
      const refs = expressionAliases(predicate);
      return (
        refs.size === 0 ||
        [...refs].every((alias) => includedAliases.has(alias))
      );
    });
    const joinedSource = sources[index]!;
    const alias = sourceAlias(joinedSource);
    const id = `join-${index}`;
    const targetStageId = sourceStageIds.get(alias.toLowerCase());
    stage(stages, {
      id,
      kind: "join",
      title: `${String(joinedSource.join || "JOIN").toUpperCase()} ${alias}`,
      description: `Combines ${includedSources
        .slice(0, -1)
        .map(sourceAlias)
        .join(
          ", ",
        )} with ${alias} using the query's join condition, then applies all filters available at this point.`,
      sql: buildStageStatement(parsed, includedSources, applicablePredicates),
      inputStageIds: [previousStageId, targetStageId].filter(
        Boolean,
      ) as string[],
      aliases: [...includedAliases],
      executable: true,
      note:
        String(joinedSource.join || "")
          .toUpperCase()
          .includes("OUTER") ||
        /^(LEFT|RIGHT|FULL)/i.test(String(joinedSource.join || ""))
          ? "Outer-join filters are evaluated in their original WHERE position; source previews are diagnostic inputs, not predicate pushdown claims."
          : undefined,
    });
    previousStageId = id;
  }

  stage(stages, {
    id: "final",
    kind: "final",
    title: "Final result",
    description:
      parsed.groupby || parsed.having
        ? "Applies grouping, aggregate functions, HAVING, projection, distinctness, and ordering from the original query."
        : "Applies the original SELECT projection, distinctness, ordering, and row limit.",
    sql: sourceSql,
    inputStageIds: previousStageId ? [previousStageId] : [],
    aliases: [...allAliases],
    executable: true,
  });

  if (sources.length > 1) {
    warnings.push(
      "This is a logical diagnostic trace built from real intermediate queries, not NetSuite's private physical optimizer plan.",
    );
  }
  if (sources.length === 0) {
    warnings.push(
      "No top-level FROM source was detected; only the final query can be executed.",
    );
  }

  return { sql: sourceSql, stages, warnings };
};

export const getSuiteQLTraceMultiplication = (
  plan: SuiteQLTracePlan,
  traceStage: SuiteQLTraceStage,
) => {
  if (traceStage.kind !== "join" || traceStage.rowCount === null) return null;
  const left = plan.stages.find(
    (candidate) => candidate.id === traceStage.inputStageIds[0],
  );
  if (!left || left.rowCount === null || left.rowCount === 0) return null;
  const factor = traceStage.rowCount / left.rowCount;
  return factor > 1 ? factor : null;
};
