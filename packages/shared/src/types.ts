/**
 * Firebase互換のエラーコード型
 * gRPCステータスコードに基づく
 */
export type FirestoreErrorCode =
  | "cancelled"
  | "unknown"
  | "invalid-argument"
  | "deadline-exceeded"
  | "not-found"
  | "already-exists"
  | "permission-denied"
  | "resource-exhausted"
  | "failed-precondition"
  | "aborted"
  | "out-of-range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data-loss"
  | "unauthenticated";

/** Firestoreエラーコード定数 */
export const ERROR_CODES = {
  CANCELLED: "cancelled",
  UNKNOWN: "unknown",
  INVALID_ARGUMENT: "invalid-argument",
  DEADLINE_EXCEEDED: "deadline-exceeded",
  NOT_FOUND: "not-found",
  ALREADY_EXISTS: "already-exists",
  PERMISSION_DENIED: "permission-denied",
  RESOURCE_EXHAUSTED: "resource-exhausted",
  FAILED_PRECONDITION: "failed-precondition",
  ABORTED: "aborted",
  OUT_OF_RANGE: "out-of-range",
  UNIMPLEMENTED: "unimplemented",
  INTERNAL: "internal",
  UNAVAILABLE: "unavailable",
  DATA_LOSS: "data-loss",
  UNAUTHENTICATED: "unauthenticated",
} as const satisfies Record<string, FirestoreErrorCode>;

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

/** シリアライズされたGeoPoint */
export interface SerializedGeoPoint {
  __type: "geopoint";
  value: { latitude: number; longitude: number };
}

/** シリアライズされたBytes */
export interface SerializedBytes {
  __type: "bytes";
  value: string; // Base64エンコードされたバイナリデータ
}

/** シリアライズされたDocumentReference */
export interface SerializedReference {
  __type: "reference";
  value: string; // ドキュメントパス
}

/** シリアライズされたVectorValue（ドキュメントデータ内の表現） */
export interface SerializedVectorValue {
  __type: "vector";
  values: number[];
}

/**
 * シリアライズされた非有限数値（NaN / Infinity / -Infinity）
 *
 * JSON では NaN / Infinity を表現できない（null になってしまう）ため、
 * 特殊型ラッパーとしてワイヤ上を運ぶ。有限数値は素の JSON number のまま。
 */
export interface SerializedDouble {
  __type: "double";
  value: "NaN" | "Infinity" | "-Infinity";
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

/** ユニオン型を交差型に変換する */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/** オブジェクト型の各キーに `Prefix.` を付与した型 */
export type AddPrefixToKeys<Prefix extends string, T extends Record<string, unknown>> = {
  [K in keyof T & string as `${Prefix}.${K}`]+?: string extends K ? unknown : T[K];
};

/** ネストしたオブジェクトのフィールドをドット記法キーに展開する（1階層分） */
export type ChildUpdateFields<K extends string, V> =
  V extends Record<string, unknown> ? AddPrefixToKeys<K, UpdateData<V>> : never;

/** ネストした全フィールドのドット記法キーの交差型 */
export type NestedUpdateFields<T extends Record<string, unknown>> = UnionToIntersection<
  {
    [K in keyof T & string]: ChildUpdateFields<K, T[K]>;
  }[keyof T & string]
>;

/**
 * updateDoc 用の型。トップレベルフィールドに加えて
 * `"nested.field"` のようなドット記法キーでのネストフィールド更新を型付けする。
 */
export type UpdateData<T> = T extends Primitive
  ? T
  : T extends Record<string, unknown>
    ? { [K in keyof T]?: UpdateData<T[K]> | FieldValueSentinel } & NestedUpdateFields<T>
    : Partial<T>;

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
  | SerializedCompositeFilterConstraint
  | SerializedFindNearestConstraint;

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

/** ベクトル距離の測定方法 */
export type VectorDistanceMeasure = "EUCLIDEAN" | "COSINE" | "DOT_PRODUCT";

/** シリアライズされたベクトル近傍検索制約 */
export interface SerializedFindNearestConstraint {
  type: "findNearest";
  fieldPath: string;
  queryVector: number[];
  limit: number;
  distanceMeasure: VectorDistanceMeasure;
  /** 指定時、各ドキュメントの距離をこのフィールド名で結果データに含める */
  distanceResultField?: string;
  /** 指定時、この距離以内（DOT_PRODUCT は以上）のドキュメントのみ返す */
  distanceThreshold?: number;
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
