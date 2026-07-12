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
import {
  applyQueryConstraints,
  matchesCollection,
  validateQueryFilters,
} from "@local-firestore/shared";
import { getLocalStore } from "./local-store.js";
import { isNetworkEnabled } from "./network-state.js";
import { deserializeData, serializeValue } from "./serialization.js";
import { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
import { FirestoreError, isTransientError } from "./transport.js";
import type { CollectionReference, Firestore } from "./types.js";
import { DocumentSnapshot, FieldPath, SnapshotMetadata } from "./types.js";
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
  /**
   * @internal スナップショットカーソル（`startAt(snapshot)` 形式）の場合に設定される。
   * `query()` でクエリに組み込まれる際、orderBy フィールドの値 + `__name__`
   * （ドキュメントパス）へ展開される。
   */
  readonly _cursorSnapshot?: SnapshotCursorSource;
}

/** スナップショットカーソルとして渡せるスナップショット型 */
type SnapshotCursorSource = DocumentSnapshot<unknown> | QueryDocumentSnapshot<unknown>;

/** カーソル制約の種別 */
type CursorConstraintType = "startAt" | "startAfter" | "endAt" | "endBefore";

/** 値がドキュメントスナップショットかどうか判定する */
function isSnapshotCursorSource(value: unknown): value is SnapshotCursorSource {
  return value instanceof DocumentSnapshot || value instanceof QueryDocumentSnapshot;
}

/** カーソル制約を作成する（スナップショット形式は解決を query() まで遅延する） */
function cursorConstraint(type: CursorConstraintType, values: unknown[]): QueryConstraint {
  if (values.length === 1 && isSnapshotCursorSource(values[0])) {
    const snapshot = values[0];
    if (!snapshot.exists()) {
      throw new FirestoreError(
        "invalid-argument",
        `Invalid query. You are trying to start or end a query using a document that doesn't exist.`,
      );
    }
    return {
      _serialized: { type, values: [] },
      _cursorSnapshot: snapshot,
    };
  }
  return {
    _serialized: { type, values: values.map((v) => serializeValue(v)) },
  };
}

/**
 * スナップショットカーソルを orderBy フィールドの値へ展開する
 *
 * 本家 SDK と同様に、クエリの orderBy フィールドの値をスナップショットから抽出し、
 * 末尾に `__name__`（ドキュメントパス）のタイブレーク値を付与する。
 * サーバー側は暗黙の `__name__` orderBy を補うため、orderBy 数 + 1 個の値を送れる。
 */
function resolveSnapshotCursor(
  type: CursorConstraintType,
  snapshot: SnapshotCursorSource,
  precedingConstraints: SerializedQueryConstraint[],
): SerializedQueryConstraint {
  const orderBys = precedingConstraints.filter((c) => c.type === "orderBy");
  const docPath = snapshot.ref.path;

  const values: unknown[] = [];
  let hasNameOrderBy = false;
  for (const o of orderBys) {
    if (o.fieldPath === "__name__") {
      values.push(docPath);
      hasNameOrderBy = true;
      continue;
    }
    const value = snapshot.get(o.fieldPath);
    if (value === undefined) {
      throw new FirestoreError(
        "invalid-argument",
        `Invalid query. You are trying to start or end a query using a document for which the field '${o.fieldPath}' (used as the orderBy) does not exist.`,
      );
    }
    values.push(serializeValue(value));
  }

  // 暗黙の __name__ タイブレーク（同値ドキュメントを正しくスキップするために必須）
  if (!hasNameOrderBy) {
    values.push(docPath);
  }

  return { type, values };
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

  // スナップショットカーソルは、ここまでに指定された orderBy を使って値へ展開する
  const merged: SerializedQueryConstraint[] = [...base.constraints];
  for (const c of constraints) {
    if (c._cursorSnapshot) {
      merged.push(
        resolveSnapshotCursor(
          c._serialized.type as CursorConstraintType,
          c._cursorSnapshot,
          merged,
        ),
      );
    } else {
      merged.push(c._serialized);
    }
  }

  return createQuery<T>(
    base.collectionPath,
    base.collectionGroup,
    merged,
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

/**
 * startAtカーソル制約を作成する
 *
 * フィールド値の列挙、または `DocumentSnapshot` を渡せる（本家互換）。
 * スナップショットを渡した場合、orderBy フィールドの値とドキュメントパスが
 * カーソル値として使われる。
 */
export function startAt(...values: unknown[]): QueryConstraint {
  return cursorConstraint("startAt", values);
}

/** startAfterカーソル制約を作成する（フィールド値または DocumentSnapshot） */
export function startAfter(...values: unknown[]): QueryConstraint {
  return cursorConstraint("startAfter", values);
}

/** endAtカーソル制約を作成する（フィールド値または DocumentSnapshot） */
export function endAt(...values: unknown[]): QueryConstraint {
  return cursorConstraint("endAt", values);
}

/** endBeforeカーソル制約を作成する（フィールド値または DocumentSnapshot） */
export function endBefore(...values: unknown[]): QueryConstraint {
  return cursorConstraint("endBefore", values);
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

/** findNearest の limit 上限（本家仕様） */
const MAX_FIND_NEAREST_LIMIT = 1000;

/** クエリベクトルの最大次元数（本家仕様） */
const MAX_VECTOR_DIMENSIONS = 2048;

/** 有効な距離測定方法 */
const VALID_DISTANCE_MEASURES: readonly VectorDistanceMeasure[] = [
  "EUCLIDEAN",
  "COSINE",
  "DOT_PRODUCT",
];

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
  if (queryVector.length > MAX_VECTOR_DIMENSIONS) {
    throw new FirestoreError(
      "invalid-argument",
      `queryVector dimension (${queryVector.length}) exceeds the maximum of ${MAX_VECTOR_DIMENSIONS}`,
    );
  }
  if (!queryVector.every((v) => typeof v === "number" && Number.isFinite(v))) {
    throw new FirestoreError("invalid-argument", "queryVector must contain only finite numbers");
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new FirestoreError("invalid-argument", "limit must be a positive integer");
  }
  if (options.limit > MAX_FIND_NEAREST_LIMIT) {
    throw new FirestoreError(
      "invalid-argument",
      `limit (${options.limit}) exceeds the maximum of ${MAX_FIND_NEAREST_LIMIT} for findNearest queries`,
    );
  }
  if (!VALID_DISTANCE_MEASURES.includes(options.distanceMeasure)) {
    throw new FirestoreError(
      "invalid-argument",
      `Invalid distanceMeasure: "${options.distanceMeasure}". ` +
        `Must be one of ${VALID_DISTANCE_MEASURES.join(", ")}.`,
    );
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

/**
 * クエリを実行してドキュメント一覧を取得する（本家互換）
 *
 * サーバーで実行するが、ネットワーク無効時・サーバー到達不能時
 * （一過性エラー）はローカルキャッシュでのクエリ評価へフォールバックし
 * `fromCache: true` のスナップショットを返す。
 */
export async function getDocs<T = DocumentData>(
  queryOrRef: Query<T> | CollectionReference<T>,
): Promise<QuerySnapshot<T>> {
  const q: Query<T> = queryOrRef.type === "collection" ? query(queryOrRef) : queryOrRef;

  if (!isNetworkEnabled(q._firestore)) {
    return getDocsFromCache(queryOrRef);
  }
  try {
    return await getDocsFromServer(queryOrRef);
  } catch (err) {
    // 一過性エラー（transport のリトライ後も解消しないネットワーク断等）のみ
    // フォールバックする。permission-denied 等の恒久エラーはそのまま投げる
    if (!isTransientError(err)) throw err;
    // findNearest はキャッシュ実行できないため元のエラーを投げ直す
    if (q.constraints.some((c) => c.type === "findNearest")) throw err;
    return getDocsFromCache(queryOrRef);
  }
}

/** クエリをサーバーで実行する（キャッシュフォールバックなし、本家互換） */
export async function getDocsFromServer<T = DocumentData>(
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

  // 結果をサーバー確定値としてローカルストアへ反映する（キャッシュ読み取り・
  // acknowledged mutation の解決に使われる）
  getLocalStore(firestore).applyRemoteDocs(
    res.docs.map((d) => ({
      path: d.path,
      exists: true,
      data: d.data,
      createTime: d.createTime,
      updateTime: d.updateTime,
    })),
  );
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

  // 本家がエラーにするフィルタ組合せ・要素数制限（in/not-in/array-contains-any 等）
  const filterError = validateQueryFilters(constraints);
  if (filterError !== null) {
    throw new FirestoreError("invalid-argument", filterError);
  }
}

/**
 * クエリをローカルキャッシュから実行する（本家互換）
 *
 * ローカルストアが知っている全ドキュメント（サーバー確定値 + pending write の
 * overlay）に対してクエリ制約をローカル評価し、`fromCache: true` の
 * スナップショットを返す。本家同様「キャッシュにある範囲の結果」であり、
 * サーバーの全データに対する結果とは限らない。
 */
export async function getDocsFromCache<T = DocumentData>(
  queryOrRef: Query<T> | CollectionReference<T>,
): Promise<QuerySnapshot<T>> {
  const q: Query<T> = queryOrRef.type === "collection" ? query(queryOrRef) : queryOrRef;

  validateConstraints(q.constraints);
  if (q.constraints.some((c) => c.type === "findNearest")) {
    throw new FirestoreError("unavailable", "findNearest queries cannot be executed from cache");
  }

  const firestore = q._firestore;
  const localStore = getLocalStore(firestore);
  const candidates: Array<{
    path: string;
    data: DocumentData;
    createTime: string | null;
    updateTime: string | null;
    hasPendingWrites: boolean;
  }> = [];
  for (const path of localStore.getKnownPaths()) {
    if (!matchesCollection(path, q.collectionPath, q.collectionGroup)) continue;
    const composed = localStore.composeDocument(path);
    if (composed?.exists && composed.data) {
      candidates.push({
        path,
        data: composed.data,
        createTime: composed.createTime,
        updateTime: composed.updateTime,
        hasPendingWrites: composed.hasPendingWrites,
      });
    }
  }

  const results = applyQueryConstraints(
    candidates,
    q.collectionPath,
    q.collectionGroup,
    q.constraints,
  );

  const converter = q._converter;
  const docs = results.map((d) => {
    const segments = d.path.split("/");
    const docId = segments[segments.length - 1];
    const metadata = new SnapshotMetadata(d.hasPendingWrites, true);
    let docData = deserializeData(d.data, firestore);
    if (converter) {
      const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
        d.path,
        docId,
        docData,
        d.createTime ?? "",
        d.updateTime ?? "",
        firestore,
      );
      docData = converter.fromFirestore(rawSnapshot) as DocumentData;
    }
    return new QueryDocumentSnapshot<T>(
      d.path,
      docId,
      docData as T,
      d.createTime ?? "",
      d.updateTime ?? "",
      firestore,
      metadata,
    );
  });

  const hasPendingWrites = results.some((d) => d.hasPendingWrites);
  return new QuerySnapshot<T>(
    docs,
    undefined,
    queryOrRef,
    new SnapshotMetadata(hasPendingWrites, true),
  );
}
