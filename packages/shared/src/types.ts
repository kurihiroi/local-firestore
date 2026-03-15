/** Firestoreエラーコード定数 */
export const ERROR_CODES = {
  ABORTED: "aborted",
  NOT_FOUND: "not-found",
  DEADLINE_EXCEEDED: "deadline-exceeded",
  INVALID_ARGUMENT: "invalid-argument",
} as const;

/** Firestoreドキュメントのデータ型 */
export interface DocumentData {
  [field: string]: unknown;
}

/** シリアライズされた特殊型のラッパー */
export interface SerializedSpecialValue {
  __type: "timestamp" | "geopoint" | "bytes" | "reference";
  value: unknown;
}

/** シリアライズされたTimestamp */
export interface SerializedTimestamp {
  __type: "timestamp";
  value: { seconds: number; nanoseconds: number };
}

/** FieldValueセンチネルの種別 */
export type FieldValueType =
  | "serverTimestamp"
  | "deleteField"
  | "increment"
  | "arrayUnion"
  | "arrayRemove";

/** FieldValueセンチネル（クライアント→サーバーで送信される） */
export interface FieldValueSentinel {
  __fieldValue: true;
  type: FieldValueType;
  value?: unknown;
}

/** ドキュメントのメタデータ（サーバー内部で保持） */
export interface DocumentMetadata {
  path: string;
  collectionPath: string;
  documentId: string;
  data: DocumentData;
  version: number;
  createTime: string;
  updateTime: string;
}

/** SetOptions */
export type SetOptions = { merge: true } | { mergeFields: string[] };

// ============================================================
// クエリ関連型
// ============================================================

/** Whereフィルタの演算子 */
export type WhereFilterOp =
  | "<"
  | "<="
  | "=="
  | "!="
  | ">="
  | ">"
  | "array-contains"
  | "in"
  | "not-in"
  | "array-contains-any";

/** ソート方向 */
export type OrderByDirection = "asc" | "desc";

/** クエリ制約の種別 */
export type QueryConstraintType =
  | "where"
  | "orderBy"
  | "limit"
  | "limitToLast"
  | "startAt"
  | "startAfter"
  | "endAt"
  | "endBefore";

/** シリアライズされたクエリ制約（クライアント→サーバー送信用） */
export type SerializedQueryConstraint =
  | SerializedWhereConstraint
  | SerializedOrderByConstraint
  | SerializedLimitConstraint
  | SerializedCursorConstraint
  | SerializedCompositeFilterConstraint;

export interface SerializedWhereConstraint {
  type: "where";
  fieldPath: string;
  op: WhereFilterOp;
  value: unknown;
}

export interface SerializedOrderByConstraint {
  type: "orderBy";
  fieldPath: string;
  direction: OrderByDirection;
}

export interface SerializedLimitConstraint {
  type: "limit" | "limitToLast";
  limit: number;
}

export interface SerializedCursorConstraint {
  type: "startAt" | "startAfter" | "endAt" | "endBefore";
  values: unknown[];
}

export interface SerializedCompositeFilterConstraint {
  type: "and" | "or";
  filters: SerializedWhereConstraint[];
}

// ============================================================
// 集計クエリ関連型
// ============================================================

/** 集計の種別 */
export type AggregateType = "count" | "sum" | "avg";

/** シリアライズされた集計フィールド指定 */
export interface SerializedAggregateField {
  aggregateType: AggregateType;
  fieldPath?: string;
}

/** 集計スペック（エイリアス名 → 集計フィールド指定） */
export interface SerializedAggregateSpec {
  [alias: string]: SerializedAggregateField;
}
