import type {
  AggregateResultData,
  DocumentMetadata,
  SerializedAggregateSpec,
  SerializedCompositeFilterConstraint,
  SerializedCursorConstraint,
  SerializedLimitConstraint,
  SerializedOrderByConstraint,
  SerializedQueryConstraint,
  SerializedWhereConstraint,
} from "@local-firestore/shared";
import type Database from "better-sqlite3";

export class QueryService {
  constructor(private db: Database.Database) {}

  executeQuery(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    collectionGroup = false,
  ): DocumentMetadata[] {
    const { conditions, params } = buildFilterConditions(
      collectionPath,
      constraints,
      collectionGroup,
    );

    const orderBys = constraints.filter(
      (c): c is SerializedOrderByConstraint => c.type === "orderBy",
    );
    const limits = constraints.filter(
      (c): c is SerializedLimitConstraint => c.type === "limit" || c.type === "limitToLast",
    );
    const cursors = constraints.filter(
      (c): c is SerializedCursorConstraint =>
        c.type === "startAt" ||
        c.type === "startAfter" ||
        c.type === "endAt" ||
        c.type === "endBefore",
    );

    // ORDER BY
    let orderByClause = "";
    if (orderBys.length > 0) {
      const parts = orderBys.map(
        (o) => `json_extract(data, '$.${escapePath(o.fieldPath)}') ${o.direction.toUpperCase()}`,
      );
      orderByClause = ` ORDER BY ${parts.join(", ")}`;
    }

    // カーソル条件（orderByが必要）
    if (cursors.length > 0 && orderBys.length > 0) {
      for (const cursor of cursors) {
        const { sql, sqlParams } = buildCursorClause(cursor, orderBys);
        conditions.push(sql);
        params.push(...sqlParams);
      }
    }

    // LIMIT
    let limitClause = "";
    let isLimitToLast = false;
    for (const l of limits) {
      if (l.type === "limitToLast") {
        isLimitToLast = true;
        limitClause = ` LIMIT ?`;
        params.push(l.limit);
      } else {
        limitClause = ` LIMIT ?`;
        params.push(l.limit);
      }
    }

    // limitToLastの場合、ソート方向を反転
    if (isLimitToLast && orderBys.length > 0) {
      const parts = orderBys.map((o) => {
        const reversed = o.direction === "asc" ? "DESC" : "ASC";
        return `json_extract(data, '$.${escapePath(o.fieldPath)}') ${reversed}`;
      });
      orderByClause = ` ORDER BY ${parts.join(", ")}`;
    }

    const sql = `SELECT * FROM documents WHERE ${conditions.join(" AND ")}${orderByClause}${limitClause}`;
    const rows = this.db.prepare(sql).all(...params) as RawRow[];

    const results = rows.map(toMetadata);

    // limitToLastの場合、結果を元の順序に戻す
    if (isLimitToLast) {
      results.reverse();
    }

    return results;
  }

  executeAggregate(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    aggregateSpec: SerializedAggregateSpec,
    collectionGroup = false,
  ): AggregateResultData {
    const { conditions, params } = buildFilterConditions(
      collectionPath,
      constraints,
      collectionGroup,
    );

    // 集計SELECT式を構築
    const selectParts: string[] = [];
    const aliases = Object.keys(aggregateSpec);
    for (const alias of aliases) {
      validateAlias(alias);
      const field = aggregateSpec[alias];
      switch (field.aggregateType) {
        case "count":
          selectParts.push(`COUNT(*) AS "${alias}"`);
          break;
        case "sum": {
          if (!field.fieldPath) {
            throw new Error("sum requires a fieldPath");
          }
          const fieldExpr = `json_extract(data, '$.${escapePath(field.fieldPath)}')`;
          selectParts.push(`COALESCE(SUM(${fieldExpr}), 0) AS "${alias}"`);
          break;
        }
        case "avg": {
          if (!field.fieldPath) {
            throw new Error("avg requires a fieldPath");
          }
          const fieldExpr = `json_extract(data, '$.${escapePath(field.fieldPath)}')`;
          selectParts.push(`AVG(${fieldExpr}) AS "${alias}"`);
          break;
        }
        default: {
          const _exhaustive: never = field.aggregateType;
          throw new Error(`Unsupported aggregate type: ${_exhaustive}`);
        }
      }
    }

    const sql = `SELECT ${selectParts.join(", ")} FROM documents WHERE ${conditions.join(" AND ")}`;
    const row = this.db.prepare(sql).get(...params) as Record<string, number | null> | undefined;

    const result: AggregateResultData = {};
    for (const alias of aliases) {
      result[alias] = row ? (row[alias] ?? null) : null;
    }
    return result;
  }
}

/** WHERE条件の共通構築ロジック（executeQuery / executeAggregate 共通） */
function buildFilterConditions(
  collectionPath: string,
  constraints: SerializedQueryConstraint[],
  collectionGroup: boolean,
): { conditions: string[]; params: unknown[] } {
  const wheres = constraints.filter((c): c is SerializedWhereConstraint => c.type === "where");
  const composites = constraints.filter(
    (c): c is SerializedCompositeFilterConstraint => c.type === "and" || c.type === "or",
  );

  const params: unknown[] = [];
  const conditions: string[] = [];

  // コレクション条件
  if (collectionGroup) {
    conditions.push("(collection_path = ? OR collection_path LIKE ?)");
    params.push(collectionPath, `%/${collectionPath}`);
  } else {
    conditions.push("collection_path = ?");
    params.push(collectionPath);
  }

  // whereフィルタ
  for (const w of wheres) {
    const { sql, sqlParams } = buildWhereClause(w);
    conditions.push(sql);
    params.push(...sqlParams);
  }

  // 複合フィルタ (and/or)
  for (const comp of composites) {
    const { sql, sqlParams } = buildCompositeClause(comp);
    conditions.push(sql);
    params.push(...sqlParams);
  }

  return { conditions, params };
}

function validateAlias(alias: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid aggregate alias: "${alias}"`);
  }
}

function buildWhereClause(w: SerializedWhereConstraint): {
  sql: string;
  sqlParams: unknown[];
} {
  // __name__ はドキュメントIDを指す特殊フィールド
  if (w.fieldPath === "__name__") {
    const idExpr = "document_id";
    switch (w.op) {
      case "==":
        return { sql: `${idExpr} = ?`, sqlParams: [w.value] };
      case "!=":
        return { sql: `${idExpr} != ?`, sqlParams: [w.value] };
      case "in": {
        const values = w.value as unknown[];
        const placeholders = values.map(() => "?").join(", ");
        return { sql: `${idExpr} IN (${placeholders})`, sqlParams: values };
      }
      case "not-in": {
        const values = w.value as unknown[];
        const placeholders = values.map(() => "?").join(", ");
        return { sql: `${idExpr} NOT IN (${placeholders})`, sqlParams: values };
      }
      default:
        throw new Error(`Unsupported operator for documentId(): ${w.op}`);
    }
  }

  const fieldExpr = `json_extract(data, '$.${escapePath(w.fieldPath)}')`;

  switch (w.op) {
    case "==":
      return { sql: `${fieldExpr} = ?`, sqlParams: [toSqlValue(w.value)] };
    case "!=":
      return { sql: `${fieldExpr} != ?`, sqlParams: [toSqlValue(w.value)] };
    case "<":
      return { sql: `${fieldExpr} < ?`, sqlParams: [toSqlValue(w.value)] };
    case "<=":
      return { sql: `${fieldExpr} <= ?`, sqlParams: [toSqlValue(w.value)] };
    case ">":
      return { sql: `${fieldExpr} > ?`, sqlParams: [toSqlValue(w.value)] };
    case ">=":
      return { sql: `${fieldExpr} >= ?`, sqlParams: [toSqlValue(w.value)] };
    case "array-contains":
      return {
        sql: `EXISTS (SELECT 1 FROM json_each(${fieldExpr}) WHERE value = ?)`,
        sqlParams: [toSqlValue(w.value)],
      };
    case "array-contains-any": {
      const values = w.value as unknown[];
      const placeholders = values.map(() => "?").join(", ");
      return {
        sql: `EXISTS (SELECT 1 FROM json_each(${fieldExpr}) WHERE value IN (${placeholders}))`,
        sqlParams: values.map(toSqlValue),
      };
    }
    case "in": {
      const values = w.value as unknown[];
      const placeholders = values.map(() => "?").join(", ");
      return {
        sql: `${fieldExpr} IN (${placeholders})`,
        sqlParams: values.map(toSqlValue),
      };
    }
    case "not-in": {
      const values = w.value as unknown[];
      const placeholders = values.map(() => "?").join(", ");
      return {
        sql: `${fieldExpr} NOT IN (${placeholders})`,
        sqlParams: values.map(toSqlValue),
      };
    }
    default:
      throw new Error(`Unsupported operator: ${w.op}`);
  }
}

function buildCompositeClause(comp: SerializedCompositeFilterConstraint): {
  sql: string;
  sqlParams: unknown[];
} {
  const joiner = comp.type === "and" ? " AND " : " OR ";
  const parts: string[] = [];
  const params: unknown[] = [];

  for (const filter of comp.filters) {
    const { sql, sqlParams } = buildWhereClause(filter);
    parts.push(sql);
    params.push(...sqlParams);
  }

  return { sql: `(${parts.join(joiner)})`, sqlParams: params };
}

function buildCursorClause(
  cursor: SerializedCursorConstraint,
  orderBys: SerializedOrderByConstraint[],
): { sql: string; sqlParams: unknown[] } {
  // 単一フィールドカーソルのみサポート（Phase 1では十分）
  const params: unknown[] = [];
  const conditions: string[] = [];

  for (let i = 0; i < Math.min(cursor.values.length, orderBys.length); i++) {
    const orderBy = orderBys[i];
    const fieldExpr = `json_extract(data, '$.${escapePath(orderBy.fieldPath)}')`;
    const value = toSqlValue(cursor.values[i]);

    let op: string;
    switch (cursor.type) {
      case "startAt":
        op = orderBy.direction === "asc" ? ">=" : "<=";
        break;
      case "startAfter":
        op = orderBy.direction === "asc" ? ">" : "<";
        break;
      case "endAt":
        op = orderBy.direction === "asc" ? "<=" : ">=";
        break;
      case "endBefore":
        op = orderBy.direction === "asc" ? "<" : ">";
        break;
    }

    conditions.push(`${fieldExpr} ${op} ?`);
    params.push(value);
  }

  return { sql: conditions.join(" AND "), sqlParams: params };
}

function toSqlValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

function escapePath(fieldPath: string): string {
  // SQLインジェクション対策: フィールドパスに使える文字のみ許可
  if (!/^[a-zA-Z0-9_.]+$/.test(fieldPath)) {
    throw new Error(`Invalid field path: "${fieldPath}"`);
  }
  return fieldPath;
}

interface RawRow {
  path: string;
  collection_path: string;
  document_id: string;
  data: string;
  version: number;
  create_time: string;
  update_time: string;
}

function toMetadata(row: RawRow): DocumentMetadata {
  return {
    path: row.path,
    collectionPath: row.collection_path,
    documentId: row.document_id,
    data: JSON.parse(row.data),
    version: row.version,
    createTime: row.create_time,
    updateTime: row.update_time,
  };
}
