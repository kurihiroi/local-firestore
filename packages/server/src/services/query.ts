import type {
  AggregateResultData,
  DocumentMetadata,
  SerializedAggregateSpec,
  SerializedCompositeFilterConstraint,
  SerializedCursorConstraint,
  SerializedFindNearestConstraint,
  SerializedLimitConstraint,
  SerializedOrderByConstraint,
  SerializedQueryConstraint,
  SerializedWhereConstraint,
} from "@local-firestore/shared";
import {
  nextTypeTag,
  TYPE_TAG,
  validateQueryFilters,
  valueKey,
  valueTypeTag,
} from "@local-firestore/shared";
import type Database from "better-sqlite3";

/** クエリ制約が本家 Firestore で不正となるケースのエラー */
export class QueryValidationError extends Error {
  readonly code = "invalid-argument";
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

/** 実効 orderBy（暗黙の __name__ タイブレークを含む） */
interface OrderKey {
  /** SQL 式（firestore_key(...) または path カラム） */
  expr: string;
  direction: "asc" | "desc";
  /** __name__（ドキュメントパス）順序かどうか */
  isName: boolean;
  fieldPath: string;
}

export class QueryService {
  constructor(private db: Database.Database) {}

  executeQuery(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    collectionGroup = false,
  ): DocumentMetadata[] {
    const findNearest = constraints.find(
      (c): c is SerializedFindNearestConstraint => c.type === "findNearest",
    );
    if (findNearest) {
      return this.executeFindNearest(collectionPath, constraints, findNearest, collectionGroup);
    }

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

    // 本家同様、limitToLast には orderBy が必須
    const isLimitToLast = limits.length > 0 && limits[limits.length - 1].type === "limitToLast";
    if (isLimitToLast && orderBys.length === 0) {
      throw new QueryValidationError(
        "limitToLast() queries require specifying at least one orderBy() clause",
      );
    }

    // 実効 orderBy を構築（明示 orderBy + 暗黙の __name__ タイブレーク）
    const orderKeys = buildOrderKeys(orderBys, constraints);

    // 明示 orderBy 対象フィールドが存在しないドキュメントは除外する（本家と同じ挙動）
    for (const o of orderBys) {
      if (o.fieldPath !== "__name__") {
        conditions.push(`${fieldJsonExpr(o.fieldPath)} IS NOT NULL`);
      }
    }

    // カーソル条件（実効 orderBy に対する辞書式タプル比較）
    for (const cursor of cursors) {
      const built = buildCursorClause(cursor, orderKeys, collectionPath);
      if (built) {
        conditions.push(built.sql);
        params.push(...built.sqlParams);
      }
    }

    // ORDER BY（limitToLast の場合は方向を反転して LIMIT 後に元へ戻す）
    const orderByClause = ` ORDER BY ${orderKeys
      .map((o) => {
        const dir = isLimitToLast
          ? o.direction === "asc"
            ? "DESC"
            : "ASC"
          : o.direction.toUpperCase();
        return `${o.expr} ${dir}`;
      })
      .join(", ")}`;

    // LIMIT（複数指定された場合は最後の制約が有効 — 本家と同じ）
    let limitClause = "";
    if (limits.length > 0) {
      limitClause = ` LIMIT ?`;
      params.push(limits[limits.length - 1].limit);
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

  /**
   * ベクトル近傍検索を実行する
   *
   * where フィルタ適用後、対象フィールドとクエリベクトルの距離を
   * SQLite UDF（vector_distance）で計算し、距離順に limit 件返す。
   * orderBy / limit / カーソル制約は距離順ソートに置き換えられるため無視する。
   */
  private executeFindNearest(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    findNearest: SerializedFindNearestConstraint,
    collectionGroup: boolean,
  ): DocumentMetadata[] {
    const { conditions, params } = buildFilterConditions(
      collectionPath,
      constraints,
      collectionGroup,
    );

    // ベクトルは {__type:"vector", values:[...]} 形式または素の配列の両方を受け付ける
    const fieldPath = escapePath(findNearest.fieldPath);
    const fieldExpr = `COALESCE(json_extract(data, '$.${fieldPath}.values'), json_extract(data, '$.${fieldPath}'))`;
    const distanceExpr = `vector_distance(${fieldExpr}, ?, ?)`;

    const outerConditions = ["__distance IS NOT NULL"];
    const outerParams: unknown[] = [];
    if (findNearest.distanceThreshold !== undefined) {
      // DOT_PRODUCT は値が大きいほど近い
      outerConditions.push(
        findNearest.distanceMeasure === "DOT_PRODUCT" ? "__distance >= ?" : "__distance <= ?",
      );
      outerParams.push(findNearest.distanceThreshold);
    }
    const orderDirection = findNearest.distanceMeasure === "DOT_PRODUCT" ? "DESC" : "ASC";

    const sql =
      `SELECT * FROM (SELECT *, ${distanceExpr} AS __distance FROM documents WHERE ${conditions.join(" AND ")}) ` +
      `WHERE ${outerConditions.join(" AND ")} ORDER BY __distance ${orderDirection} LIMIT ?`;

    const rows = this.db
      .prepare(sql)
      .all(
        JSON.stringify(findNearest.queryVector),
        findNearest.distanceMeasure,
        ...params,
        ...outerParams,
        findNearest.limit,
      ) as (RawRow & { __distance: number })[];

    return rows.map((row) => {
      const metadata = toMetadata(row);
      if (findNearest.distanceResultField) {
        metadata.data[findNearest.distanceResultField] = row.__distance;
      }
      return metadata;
    });
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
          // 本家の sum() は数値フィールドのみを集計する（文字列等は無視）
          selectParts.push(`COALESCE(SUM(${numericFieldExpr(field.fieldPath)}), 0) AS "${alias}"`);
          break;
        }
        case "avg": {
          if (!field.fieldPath) {
            throw new Error("avg requires a fieldPath");
          }
          // 本家の avg() は数値フィールドのみを集計する（分母にも数値のみが入る）
          selectParts.push(`AVG(${numericFieldExpr(field.fieldPath)}) AS "${alias}"`);
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

/** フィールド値を JSON テキストとして取り出す式（欠損時は SQL NULL） */
function fieldJsonExpr(fieldPath: string): string {
  return `data -> '$.${escapePath(fieldPath)}'`;
}

/** フィールド値の Firestore 順序キーを計算する式 */
function fieldKeyExpr(fieldPath: string): string {
  return `firestore_key(${fieldJsonExpr(fieldPath)})`;
}

/**
 * 数値フィールドのみを取り出す式（sum / avg 用）。
 * 数値以外の型（文字列・boolean・null・マップ等）は NULL になり集計から除外される。
 */
function numericFieldExpr(fieldPath: string): string {
  const path = escapePath(fieldPath);
  return `(CASE WHEN json_type(data, '$.${path}') IN ('integer', 'real') THEN json_extract(data, '$.${path}') END)`;
}

/**
 * 実効 orderBy を構築する
 *
 * 本家 Firestore と同様に:
 * - 明示 orderBy が無く不等式フィルタがある場合、その最初のフィールドで暗黙にソート
 * - 末尾に必ず __name__（ドキュメントパス）の暗黙タイブレークを付与
 *   （方向は最後の明示 orderBy と同じ）
 */
function buildOrderKeys(
  orderBys: SerializedOrderByConstraint[],
  constraints: SerializedQueryConstraint[],
): OrderKey[] {
  const keys: OrderKey[] = [];

  const explicitFields = new Set<string>();
  for (const o of orderBys) {
    explicitFields.add(o.fieldPath);
    keys.push(
      o.fieldPath === "__name__"
        ? { expr: "path", direction: o.direction, isName: true, fieldPath: "__name__" }
        : {
            expr: fieldKeyExpr(o.fieldPath),
            direction: o.direction,
            isName: false,
            fieldPath: o.fieldPath,
          },
    );
  }

  if (keys.length === 0) {
    // 明示 orderBy なし: 最初の不等式フィルタのフィールドで暗黙ソート
    const inequalityOps = new Set(["<", "<=", ">", ">=", "!=", "not-in"]);
    const wheres = constraints.filter((c): c is SerializedWhereConstraint => c.type === "where");
    const firstInequality = wheres.find(
      (w) => inequalityOps.has(w.op) && w.fieldPath !== "__name__",
    );
    if (firstInequality) {
      keys.push({
        expr: fieldKeyExpr(firstInequality.fieldPath),
        direction: "asc",
        isName: false,
        fieldPath: firstInequality.fieldPath,
      });
    }
  }

  // 暗黙の __name__ タイブレーク
  if (!explicitFields.has("__name__")) {
    const lastDirection = keys.length > 0 ? keys[keys.length - 1].direction : "asc";
    keys.push({ expr: "path", direction: lastDirection, isName: true, fieldPath: "__name__" });
  }

  return keys;
}

/** WHERE条件の共通構築ロジック（executeQuery / executeAggregate 共通） */
function buildFilterConditions(
  collectionPath: string,
  constraints: SerializedQueryConstraint[],
  collectionGroup: boolean,
): { conditions: string[]; params: unknown[] } {
  // 本家がエラーにするフィルタ組合せ・要素数制限の防御的検証
  const filterError = validateQueryFilters(constraints);
  if (filterError !== null) {
    throw new QueryValidationError(filterError);
  }

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
        throw new QueryValidationError(`Unsupported operator for documentId(): ${w.op}`);
    }
  }

  const jsonExpr = fieldJsonExpr(w.fieldPath);
  const keyExpr = fieldKeyExpr(w.fieldPath);

  switch (w.op) {
    case "==":
      return { sql: `${keyExpr} = ?`, sqlParams: [valueKey(w.value)] };
    case "!=":
      // 本家と同様、フィールドが存在しない / null のドキュメントはマッチしない
      return {
        sql: `(${keyExpr} IS NOT NULL AND ${keyExpr} <> '${TYPE_TAG.null}' AND ${keyExpr} <> ?)`,
        sqlParams: [valueKey(w.value)],
      };
    case "<":
    case "<=":
    case ">":
    case ">=": {
      // 範囲フィルタはオペランドと同じ型の値のみマッチする（型ブラケット）
      const tag = valueTypeTag(w.value);
      const bracket =
        w.op === "<" || w.op === "<="
          ? `${keyExpr} >= '${tag}'`
          : `${keyExpr} < '${nextTypeTag(tag)}'`;
      return {
        sql: `(${keyExpr} ${w.op} ? AND ${bracket})`,
        sqlParams: [valueKey(w.value)],
      };
    }
    case "array-contains":
      return {
        sql: `firestore_arr_contains(${jsonExpr}, ?) = 1`,
        sqlParams: [valueKey(w.value)],
      };
    case "array-contains-any": {
      const values = w.value as unknown[];
      return {
        sql: `firestore_arr_contains_any(${jsonExpr}, ?) = 1`,
        sqlParams: [JSON.stringify(values.map(valueKey))],
      };
    }
    case "in": {
      const values = w.value as unknown[];
      const placeholders = values.map(() => "?").join(", ");
      return {
        sql: `${keyExpr} IN (${placeholders})`,
        sqlParams: values.map(valueKey),
      };
    }
    case "not-in": {
      const values = w.value as unknown[];
      const placeholders = values.map(() => "?").join(", ");
      return {
        sql: `(${keyExpr} IS NOT NULL AND ${keyExpr} <> '${TYPE_TAG.null}' AND ${keyExpr} NOT IN (${placeholders}))`,
        sqlParams: values.map(valueKey),
      };
    }
    default:
      throw new QueryValidationError(`Unsupported operator: ${w.op}`);
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

/**
 * カーソル制約を実効 orderBy に対する辞書式タプル比較として構築する
 *
 * 例: orderBy(a), orderBy(b) + startAfter(x, y) は
 *   (a > x) OR (a = x AND b > y)
 * になる（desc フィールドは比較方向が反転する）。
 */
function buildCursorClause(
  cursor: SerializedCursorConstraint,
  orderKeys: OrderKey[],
  collectionPath: string,
): { sql: string; sqlParams: unknown[] } | null {
  const n = Math.min(cursor.values.length, orderKeys.length);
  if (n === 0) return null;

  const isStart = cursor.type === "startAt" || cursor.type === "startAfter";
  const inclusive = cursor.type === "startAt" || cursor.type === "endAt";

  // 各フィールドの比較値（__name__ はフルパスに正規化）
  const exprs: string[] = [];
  const cursorParams: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const o = orderKeys[i];
    exprs.push(o.expr);
    if (o.isName) {
      const raw = String(cursor.values[i]);
      cursorParams.push(raw.includes("/") ? raw : `${collectionPath}/${raw}`);
    } else {
      cursorParams.push(valueKey(cursor.values[i]));
    }
  }

  const strictOp = (direction: "asc" | "desc"): string => {
    const forward = direction === "asc" ? ">" : "<";
    const backward = direction === "asc" ? "<" : ">";
    return isStart ? forward : backward;
  };

  const terms: string[] = [];
  const params: unknown[] = [];

  for (let i = 0; i < n; i++) {
    const parts: string[] = [];
    for (let j = 0; j < i; j++) {
      parts.push(`${exprs[j]} = ?`);
      params.push(cursorParams[j]);
    }
    parts.push(`${exprs[i]} ${strictOp(orderKeys[i].direction)} ?`);
    params.push(cursorParams[i]);
    terms.push(`(${parts.join(" AND ")})`);
  }

  if (inclusive) {
    const parts: string[] = [];
    for (let j = 0; j < n; j++) {
      parts.push(`${exprs[j]} = ?`);
      params.push(cursorParams[j]);
    }
    terms.push(`(${parts.join(" AND ")})`);
  }

  return { sql: `(${terms.join(" OR ")})`, sqlParams: params };
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
