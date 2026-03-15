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
// データコンバーター・型ヘルパー
// ============================================================

/** プリミティブ型 */
type Primitive = string | number | boolean | undefined | null;

/** FieldValue付きの型（setDoc用） */
export type WithFieldValue<T> = T extends Primitive
  ? T
  : T extends Record<string, unknown>
    ? { [K in keyof T]: WithFieldValue<T[K]> | FieldValueSentinel }
    : T;

/** Partial + FieldValue付きの型（merge setDoc用） */
export type PartialWithFieldValue<T> = T extends Primitive
  ? T
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: PartialWithFieldValue<T[K]> | FieldValueSentinel }
    : T;

/**
 * FirestoreDataConverter
 *
 * アプリケーション型 (AppModelType) と Firestore データ型 (DbModelType) の相互変換を行う。
 * `withConverter()` で DocumentReference / CollectionReference / Query にアタッチして使用する。
 */
export interface FirestoreDataConverter<
  AppModelType,
  DbModelType extends DocumentData = DocumentData,
> {
  /** アプリケーション型 → Firestoreデータ型に変換する（書き込み時） */
  toFirestore(modelObject: WithFieldValue<AppModelType>): WithFieldValue<DbModelType>;
  toFirestore(
    modelObject: PartialWithFieldValue<AppModelType>,
    options: SetOptions,
  ): PartialWithFieldValue<DbModelType>;

  /** Firestoreデータ型 → アプリケーション型に変換する（読み取り時） */
  fromFirestore(snapshot: { data(): DocumentData }): AppModelType;
}

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
