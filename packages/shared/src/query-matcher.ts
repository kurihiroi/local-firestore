import { nextTypeTag, pathOrderKey, TYPE_TAG, valueKey, valueTypeTag } from "./firestore-key.js";
import type {
  DocumentData,
  SerializedCompositeFilterConstraint,
  SerializedCursorConstraint,
  SerializedLimitConstraint,
  SerializedOrderByConstraint,
  SerializedQueryConstraint,
  SerializedWhereConstraint,
} from "./types.js";

/**
 * クエリ制約のローカル評価（クライアント側レイテンシ補償用）
 *
 * サーバーの QueryService（SQLite + firestore_key UDF）と同一の比較セマンティクスで
 * filter / orderBy / cursor / limit を評価する。両者の乖離は
 * server 側のパリティテスト（同一フィクスチャを両実装で実行）で検出する。
 *
 * `findNearest`（ベクトル近傍検索）はローカル評価の対象外。
 */

/** 評価対象のドキュメント（データはワイヤ形式 = __type ラッパー入り） */
export interface MatchableDocument {
  path: string;
  data: DocumentData;
}

/** ドキュメントパスから親コレクションパスを返す */
function parentCollectionPath(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, -1).join("/");
}

/** ドキュメントパスから末尾のドキュメントIDを返す */
function documentIdOf(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

/**
 * ドット記法のフィールドパスで値を取得する（SQLite json_extract と同じ走査規則）。
 * @returns フィールドが存在しない場合は undefined
 */
function getFieldValue(data: DocumentData, fieldPath: string): unknown {
  let current: unknown = data;
  for (const segment of fieldPath.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    if (!(segment in (current as Record<string, unknown>))) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * フィールドの順序キーを返す。フィールド欠損時は null
 * （SQLite の firestore_key(data -> '$.f') が SQL NULL になるのと同じ扱い）
 */
function fieldKey(data: DocumentData, fieldPath: string): string | null {
  const value = getFieldValue(data, fieldPath);
  if (value === undefined) return null;
  return valueKey(value);
}

/** ドキュメントがコレクション条件（collectionPath / collectionGroup）にマッチするか */
export function matchesCollection(
  docPath: string,
  collectionPath: string,
  collectionGroup: boolean,
): boolean {
  const parent = parentCollectionPath(docPath);
  if (collectionGroup) {
    return parent === collectionPath || parent.endsWith(`/${collectionPath}`);
  }
  return parent === collectionPath;
}

/** 単一の where フィルタを評価する */
function matchesWhere(doc: MatchableDocument, w: SerializedWhereConstraint): boolean {
  // __name__ はドキュメントIDを指す特殊フィールド（サーバーは document_id カラムで比較）
  if (w.fieldPath === "__name__") {
    const id = documentIdOf(doc.path);
    switch (w.op) {
      case "==":
        return id === w.value;
      case "!=":
        return id !== w.value;
      case "in":
        return (w.value as unknown[]).includes(id);
      case "not-in":
        return !(w.value as unknown[]).includes(id);
      default:
        throw new Error(`Unsupported operator for documentId(): ${w.op}`);
    }
  }

  const key = fieldKey(doc.data, w.fieldPath);

  switch (w.op) {
    case "==":
      return key !== null && key === valueKey(w.value);
    case "!=":
      // 本家と同様、フィールドが存在しない / null のドキュメントはマッチしない
      return key !== null && key !== TYPE_TAG.null && key !== valueKey(w.value);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      if (key === null) return false;
      // 範囲フィルタはオペランドと同じ型の値のみマッチする（型ブラケット）
      const tag = valueTypeTag(w.value);
      const target = valueKey(w.value);
      const inBracket = w.op === "<" || w.op === "<=" ? key >= tag : key < nextTypeTag(tag);
      if (!inBracket) return false;
      switch (w.op) {
        case "<":
          return key < target;
        case "<=":
          return key <= target;
        case ">":
          return key > target;
        case ">=":
          return key >= target;
      }
      return false;
    }
    case "array-contains": {
      const value = getFieldValue(doc.data, w.fieldPath);
      if (!Array.isArray(value)) return false;
      const target = valueKey(w.value);
      return value.some((el) => valueKey(el) === target);
    }
    case "array-contains-any": {
      const value = getFieldValue(doc.data, w.fieldPath);
      if (!Array.isArray(value)) return false;
      const targets = new Set((w.value as unknown[]).map(valueKey));
      return value.some((el) => targets.has(valueKey(el)));
    }
    case "in": {
      if (key === null) return false;
      return (w.value as unknown[]).some((v) => valueKey(v) === key);
    }
    case "not-in": {
      if (key === null || key === TYPE_TAG.null) return false;
      return !(w.value as unknown[]).some((v) => valueKey(v) === key);
    }
    default:
      throw new Error(`Unsupported operator: ${w.op}`);
  }
}

/** and / or 複合フィルタを評価する */
function matchesComposite(
  doc: MatchableDocument,
  comp: SerializedCompositeFilterConstraint,
): boolean {
  if (comp.type === "and") {
    return comp.filters.every((f) => matchesWhere(doc, f));
  }
  return comp.filters.some((f) => matchesWhere(doc, f));
}

/**
 * ドキュメントがクエリのフィルタ制約（where / and / or）にマッチするか。
 * orderBy の欠損フィールド除外もここで評価する（フィルタと同様に結果集合の
 * メンバーシップを決めるため）。
 */
export function matchesQueryFilters(
  doc: MatchableDocument,
  collectionPath: string,
  collectionGroup: boolean,
  constraints: ReadonlyArray<SerializedQueryConstraint>,
): boolean {
  if (!matchesCollection(doc.path, collectionPath, collectionGroup)) return false;

  for (const c of constraints) {
    if (c.type === "where") {
      if (!matchesWhere(doc, c)) return false;
    } else if (c.type === "and" || c.type === "or") {
      if (!matchesComposite(doc, c)) return false;
    } else if (c.type === "orderBy") {
      // 明示 orderBy 対象フィールドが存在しないドキュメントは除外（本家と同じ挙動）
      if (c.fieldPath !== "__name__" && fieldKey(doc.data, c.fieldPath) === null) {
        return false;
      }
    }
  }
  return true;
}

/** 実効 orderBy（暗黙の __name__ タイブレークを含む） */
interface OrderKey {
  fieldPath: string;
  direction: "asc" | "desc";
  isName: boolean;
}

/**
 * 実効 orderBy を構築する（サーバーの buildOrderKeys と同一ロジック）
 *
 * - 明示 orderBy が無く不等式フィルタがある場合、その最初のフィールドで暗黙にソート
 * - 末尾に必ず __name__（ドキュメントパス）の暗黙タイブレークを付与
 *   （方向は最後の明示 orderBy と同じ）
 */
function buildOrderKeys(constraints: ReadonlyArray<SerializedQueryConstraint>): OrderKey[] {
  const orderBys = constraints.filter(
    (c): c is SerializedOrderByConstraint => c.type === "orderBy",
  );
  const keys: OrderKey[] = [];
  const explicitFields = new Set<string>();

  for (const o of orderBys) {
    explicitFields.add(o.fieldPath);
    keys.push({
      fieldPath: o.fieldPath,
      direction: o.direction,
      isName: o.fieldPath === "__name__",
    });
  }

  if (keys.length === 0) {
    const inequalityOps = new Set(["<", "<=", ">", ">=", "!=", "not-in"]);
    const wheres = constraints.filter((c): c is SerializedWhereConstraint => c.type === "where");
    const firstInequality = wheres.find(
      (w) => inequalityOps.has(w.op) && w.fieldPath !== "__name__",
    );
    if (firstInequality) {
      keys.push({ fieldPath: firstInequality.fieldPath, direction: "asc", isName: false });
    }
  }

  if (!explicitFields.has("__name__")) {
    const lastDirection = keys.length > 0 ? keys[keys.length - 1].direction : "asc";
    keys.push({ fieldPath: "__name__", direction: lastDirection, isName: true });
  }

  return keys;
}

/** 実効 orderBy に沿った比較用キータプルを返す */
function sortKeyTuple(doc: MatchableDocument, orderKeys: OrderKey[]): string[] {
  return orderKeys.map((o) => {
    // __name__ は完全リソース名のセグメント順（サーバーの firestore_path_key と同一）
    if (o.isName) return pathOrderKey(doc.path);
    // matchesQueryFilters で欠損は除外済みだが、暗黙不等式ソートのフィールドも
    // フィルタで欠損除外されるため、ここでは存在を仮定できる。念のため欠損は最小扱い。
    return fieldKey(doc.data, o.fieldPath) ?? "";
  });
}

/** カーソル値の比較キーを返す（__name__ はフルパスへ正規化） */
function cursorKeyTuple(
  cursor: SerializedCursorConstraint,
  orderKeys: OrderKey[],
  collectionPath: string,
): string[] {
  const n = Math.min(cursor.values.length, orderKeys.length);
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const o = orderKeys[i];
    if (o.isName) {
      const raw = String(cursor.values[i]);
      keys.push(pathOrderKey(raw.includes("/") ? raw : `${collectionPath}/${raw}`));
    } else {
      keys.push(valueKey(cursor.values[i]));
    }
  }
  return keys;
}

/**
 * カーソル条件を評価する（実効 orderBy に対する辞書式タプル比較。
 * サーバーの buildCursorClause と同一セマンティクス）
 */
function satisfiesCursor(
  docKeys: string[],
  cursorKeys: string[],
  orderKeys: OrderKey[],
  cursorType: SerializedCursorConstraint["type"],
): boolean {
  const n = cursorKeys.length;
  if (n === 0) return true;

  const isStart = cursorType === "startAt" || cursorType === "startAfter";
  const inclusive = cursorType === "startAt" || cursorType === "endAt";

  // 辞書式比較: 最初に等しくない位置で方向を判定
  for (let i = 0; i < n; i++) {
    if (docKeys[i] === cursorKeys[i]) continue;
    const forward =
      orderKeys[i].direction === "asc" ? docKeys[i] > cursorKeys[i] : docKeys[i] < cursorKeys[i];
    return isStart ? forward : !forward;
  }
  // 全て等しい（カーソル位置そのもの）
  return inclusive;
}

/**
 * クエリ制約を適用して結果集合をローカルで計算する
 * （filter → orderBy 欠損除外 → cursor → sort → limit / limitToLast）
 *
 * サーバーの QueryService.executeQuery と同一の結果（内容・順序）を返す。
 */
export function applyQueryConstraints<T extends MatchableDocument>(
  docs: ReadonlyArray<T>,
  collectionPath: string,
  collectionGroup: boolean,
  constraints: ReadonlyArray<SerializedQueryConstraint>,
): T[] {
  if (constraints.some((c) => c.type === "findNearest")) {
    throw new Error("findNearest queries cannot be evaluated locally");
  }

  const orderKeys = buildOrderKeys(constraints);
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
  if (isLimitToLast && !constraints.some((c) => c.type === "orderBy")) {
    throw new Error("limitToLast() queries require specifying at least one orderBy() clause");
  }

  // フィルタ + orderBy 欠損除外 + カーソル
  const withKeys = docs
    .filter((d) => matchesQueryFilters(d, collectionPath, collectionGroup, constraints))
    .map((d) => ({ doc: d, keys: sortKeyTuple(d, orderKeys) }))
    .filter(({ keys }) =>
      cursors.every((cursor) =>
        satisfiesCursor(
          keys,
          cursorKeyTuple(cursor, orderKeys, collectionPath),
          orderKeys,
          cursor.type,
        ),
      ),
    );

  // ソート（実効 orderBy の辞書式比較）
  withKeys.sort((a, b) => {
    for (let i = 0; i < orderKeys.length; i++) {
      if (a.keys[i] === b.keys[i]) continue;
      const cmp = a.keys[i] < b.keys[i] ? -1 : 1;
      return orderKeys[i].direction === "asc" ? cmp : -cmp;
    }
    return 0;
  });

  let result = withKeys.map(({ doc }) => doc);

  // LIMIT（複数指定された場合は最後の制約が有効 — 本家と同じ）
  if (limits.length > 0) {
    const limit = limits[limits.length - 1].limit;
    result = isLimitToLast
      ? result.slice(Math.max(0, result.length - limit))
      : result.slice(0, limit);
  }

  return result;
}
