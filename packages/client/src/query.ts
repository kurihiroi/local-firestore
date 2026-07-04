import type {
  DocumentData,
  FirestoreDataConverter,
  OrderByDirection,
  QueryRequest,
  QueryResponse,
  SerializedQueryConstraint,
  SerializedWhereConstraint,
  VectorDistanceMeasure,
  WhereFilterOp,
} from "@local-firestore/shared";
import { deserializeData, serializeValue } from "./serialization.js";
import { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
import { FirestoreError } from "./transport.js";
import type { CollectionReference, Firestore } from "./types.js";
import { FieldPath } from "./types.js";
import { VectorValue } from "./vector.js";

// ============================================================
// Query型
// ============================================================

export interface Query<T = DocumentData> {
  readonly type: "query";
  readonly collectionPath: string;
  readonly collectionGroup: boolean;
  readonly constraints: SerializedQueryConstraint[];
  /** @internal */
  readonly _firestore: Firestore;
  /** @internal */
  readonly _converter: FirestoreDataConverter<T> | null;

  /** データコンバーターを設定した新しいクエリを返す */
  withConverter<U>(converter: FirestoreDataConverter<U>): Query<U>;
  withConverter(converter: null): Query<DocumentData>;
}

// ============================================================
// クエリ制約
// ============================================================

export interface QueryConstraint {
  readonly _serialized: SerializedQueryConstraint;
}

/** クエリ制約の種別リテラル型 */
export type { QueryConstraintType } from "@local-firestore/shared";

/** フィルタ制約のユニオン型 */
export type QueryFilterConstraint = QueryConstraint;

/** 非フィルタ制約のユニオン型 */
export type QueryNonFilterConstraint = QueryConstraint;

/** @internal Queryオブジェクトを生成する */
function createQuery<T>(
  collectionPath: string,
  collectionGroupFlag: boolean,
  constraints: SerializedQueryConstraint[],
  firestore: Firestore,
  converter: FirestoreDataConverter<T> | null,
): Query<T> {
  return {
    type: "query",
    collectionPath,
    collectionGroup: collectionGroupFlag,
    constraints,
    _firestore: firestore,
    _converter: converter,
    withConverter<U>(c: FirestoreDataConverter<U> | null) {
      if (c === null) {
        return createQuery<DocumentData>(
          collectionPath,
          collectionGroupFlag,
          constraints,
          firestore,
          null,
        );
      }
      return createQuery<U>(collectionPath, collectionGroupFlag, constraints, firestore, c);
    },
  };
}

/** クエリを構築する */
export function query<T = DocumentData>(
  ref: CollectionReference<T> | Query<T>,
  ...constraints: QueryConstraint[]
): Query<T> {
  const base =
    ref.type === "collection"
      ? {
          collectionPath: ref.path,
          collectionGroup: false,
          constraints: [] as SerializedQueryConstraint[],
        }
      : {
          collectionPath: ref.collectionPath,
          collectionGroup: ref.collectionGroup,
          constraints: [...ref.constraints],
        };

  return createQuery<T>(
    base.collectionPath,
    base.collectionGroup,
    [...base.constraints, ...constraints.map((c) => c._serialized)],
    ref._firestore,
    ref._converter,
  );
}

/** コレクショングループクエリを作成する */
export function collectionGroup<T = DocumentData>(
  firestore: Firestore,
  collectionId: string,
): Query<T> {
  return createQuery<T>(collectionId, true, [], firestore, null);
}

/** ドキュメントIDを指す特殊フィールドを返す（where フィルタ用） */
export function documentId(): FieldPath {
  return FieldPath.documentId();
}

/** whereフィルタ制約を作成する */
export function where(
  fieldPath: string | FieldPath,
  op: WhereFilterOp,
  value: unknown,
): QueryConstraint {
  const fieldStr = fieldPath instanceof FieldPath ? fieldPath.toString() : fieldPath;
  return {
    _serialized: { type: "where", fieldPath: fieldStr, op, value: serializeValue(value) },
  };
}

/** orderBy制約を作成する */
export function orderBy(fieldPath: string, direction: OrderByDirection = "asc"): QueryConstraint {
  return {
    _serialized: { type: "orderBy", fieldPath, direction },
  };
}

/** limit制約を作成する */
export function limit(n: number): QueryConstraint {
  return {
    _serialized: { type: "limit", limit: n },
  };
}

/** limitToLast制約を作成する */
export function limitToLast(n: number): QueryConstraint {
  return {
    _serialized: { type: "limitToLast", limit: n },
  };
}

/** startAtカーソル制約を作成する */
export function startAt(...values: unknown[]): QueryConstraint {
  return {
    _serialized: { type: "startAt", values: values.map(serializeValue) },
  };
}

/** startAfterカーソル制約を作成する */
export function startAfter(...values: unknown[]): QueryConstraint {
  return {
    _serialized: { type: "startAfter", values: values.map(serializeValue) },
  };
}

/** endAtカーソル制約を作成する */
export function endAt(...values: unknown[]): QueryConstraint {
  return {
    _serialized: { type: "endAt", values: values.map(serializeValue) },
  };
}

/** endBeforeカーソル制約を作成する */
export function endBefore(...values: unknown[]): QueryConstraint {
  return {
    _serialized: { type: "endBefore", values: values.map(serializeValue) },
  };
}

/** AND複合フィルタを作成する */
export function and(...constraints: QueryConstraint[]): QueryConstraint {
  const filters = constraints.map((c) => c._serialized as SerializedWhereConstraint);
  return {
    _serialized: { type: "and", filters },
  };
}

/** OR複合フィルタを作成する */
export function or(...constraints: QueryConstraint[]): QueryConstraint {
  const filters = constraints.map((c) => c._serialized as SerializedWhereConstraint);
  return {
    _serialized: { type: "or", filters },
  };
}

// ============================================================
// ベクトル近傍検索（FindNearest）
// ============================================================

/** findNearest のオプション */
export interface FindNearestOptions {
  /** ベクトルが格納されているフィールド */
  vectorField: string | FieldPath;
  /** 検索クエリベクトル */
  queryVector: number[] | VectorValue;
  /** 返却する最大ドキュメント数 */
  limit: number;
  /** 距離の測定方法 */
  distanceMeasure: VectorDistanceMeasure;
  /** 指定時、各ドキュメントの距離をこのフィールド名で結果データに含める */
  distanceResultField?: string;
  /** 指定時、この距離以内（DOT_PRODUCT は以上）のドキュメントのみ返す */
  distanceThreshold?: number;
}

/**
 * ベクトル近傍検索クエリを作成する
 *
 * `where` フィルタ済みのクエリと組み合わせ可能。結果は距離順にソートされる。
 * `getDocs` で実行する。
 */
export function findNearest<T = DocumentData>(
  source: CollectionReference<T> | Query<T>,
  options: FindNearestOptions,
): Query<T> {
  const queryVector =
    options.queryVector instanceof VectorValue
      ? options.queryVector.toArray()
      : [...options.queryVector];

  if (queryVector.length === 0) {
    throw new FirestoreError("invalid-argument", "queryVector must not be empty");
  }
  if (!queryVector.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new FirestoreError("invalid-argument", "queryVector must contain only finite numbers");
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new FirestoreError("invalid-argument", "limit must be a positive integer");
  }

  const fieldStr =
    options.vectorField instanceof FieldPath ? options.vectorField.toString() : options.vectorField;

  const constraint: QueryConstraint = {
    _serialized: {
      type: "findNearest",
      fieldPath: fieldStr,
      queryVector,
      limit: options.limit,
      distanceMeasure: options.distanceMeasure,
      distanceResultField: options.distanceResultField,
      distanceThreshold: options.distanceThreshold,
    },
  };

  return query(source, constraint);
}

// ============================================================
// getDocs
// ============================================================

/** クエリを実行してドキュメント一覧を取得する */
export async function getDocs<T = DocumentData>(
  queryOrRef: Query<T> | CollectionReference<T>,
): Promise<QuerySnapshot<T>> {
  const q: Query<T> = queryOrRef.type === "collection" ? query(queryOrRef) : queryOrRef;

  validateConstraints(q.constraints);

  const transport = q._firestore._transport;
  const body: QueryRequest = {
    collectionPath: q.collectionPath,
    collectionGroup: q.collectionGroup,
    constraints: q.constraints,
  };

  const res = await transport.post<QueryResponse>("/query", body);
  const converter = q._converter;

  const firestore = q._firestore;
  const docs = res.docs.map((d) => {
    const segments = d.path.split("/");
    const docId = segments[segments.length - 1];
    const docData = deserializeData(d.data, firestore);
    if (converter) {
      const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
        d.path,
        docId,
        docData,
        d.createTime,
        d.updateTime,
        firestore,
      );
      const converted = converter.fromFirestore(rawSnapshot);
      return new QueryDocumentSnapshot<T>(
        d.path,
        docId,
        converted as T,
        d.createTime,
        d.updateTime,
        firestore,
      );
    }
    return new QueryDocumentSnapshot<T>(
      d.path,
      docId,
      docData as T,
      d.createTime,
      d.updateTime,
      firestore,
    );
  });

  return new QuerySnapshot<T>(docs, undefined, queryOrRef);
}

/**
 * クエリ実行前のバリデーション（本家 SDK と同等のチェック）
 * @internal
 */
export function validateConstraints(constraints: SerializedQueryConstraint[]): void {
  const hasLimitToLast = constraints.some((c) => c.type === "limitToLast");
  const hasOrderBy = constraints.some((c) => c.type === "orderBy");
  if (hasLimitToLast && !hasOrderBy) {
    throw new FirestoreError(
      "invalid-argument",
      "limitToLast() queries require specifying at least one orderBy() clause",
    );
  }
}
