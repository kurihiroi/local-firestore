import type {
  DocumentData,
  FirestoreDataConverter,
  FirestoreErrorCode,
  SerializedQueryConstraint,
  ServerMessage,
} from "@local-firestore/shared";
import { applyQueryConstraints, matchesCollection } from "@local-firestore/shared";
import { type ConnectionManager, getConnectionManager } from "./connection.js";
import { assertNotTerminated } from "./lifecycle.js";
import { type ComposedDocument, getLocalStore } from "./local-store.js";
import type { Query } from "./query.js";
import { validateConstraints } from "./query.js";
import { deserializeData } from "./serialization.js";
import { SnapshotCache } from "./snapshot-cache.js";
import { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
import { FirestoreError } from "./transport.js";
import type {
  CollectionReference,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
} from "./types.js";
import { DocumentSnapshot as DocumentSnapshotImpl, SnapshotMetadata } from "./types.js";

/** Unsubscribe関数の型 */
export type Unsubscribe = () => void;

/** ドキュメント変更種別 */
export type DocumentChangeType = "added" | "modified" | "removed";

/** ドキュメント変更情報 */
export interface DocumentChange<T = DocumentData> {
  readonly type: DocumentChangeType;
  readonly doc: QueryDocumentSnapshot<T>;
  readonly oldIndex: number;
  readonly newIndex: number;
}

/** サブスクリプションIDごとのコールバック */
interface DocCallback<T = DocumentData> {
  kind: "doc";
  onNext: (snapshot: DocumentSnapshot<T>) => void;
  onError?: (error: FirestoreError) => void;
  ref: DocumentReference<T>;
  converter: FirestoreDataConverter<T> | null;
  /** metadata のみの変更（hasPendingWrites / fromCache）でも発火するか */
  includeMetadataChanges: boolean;
  /** 最後に発火したスナップショットの状態（重複発火の抑制に使用） */
  lastEmitted?: {
    exists: boolean;
    dataJson: string;
    updateTime: string | null;
    hasPendingWrites: boolean;
    fromCache: boolean;
  };
}

/** クエリリスナーが保持する「最後に発火した結果集合」の1件（ワイヤ形式） */
interface EmittedQueryDoc {
  path: string;
  data: DocumentData;
  createTime: string | null;
  updateTime: string | null;
  hasPendingWrites: boolean;
}

interface QueryCallback<T = DocumentData> {
  kind: "query";
  onNext: (snapshot: QuerySnapshot<T>) => void;
  onError?: (error: FirestoreError) => void;
  converter: FirestoreDataConverter<T> | null;
  firestore: Firestore;
  queryOrRef: Query<T> | CollectionReference<T>;
  collectionPath: string;
  collectionGroup: boolean;
  constraints: SerializedQueryConstraint[];
  /** findNearest クエリはローカル評価の対象外（サーバースナップショットのみ） */
  hasFindNearest: boolean;
  includeMetadataChanges: boolean;
  /**
   * 最後に発火した結果集合。docChanges() は常にこれとの差分で合成する
   * （初回は undefined = 全件 added。再接続時のフル再購読も自然に差分になる）
   */
  lastEmittedDocs?: EmittedQueryDoc[];
  lastMetadata?: { hasPendingWrites: boolean; fromCache: boolean };
  /** サーバーからの初回スナップショットを受信済みか（fromCache 判定） */
  receivedServerSnapshot: boolean;
}

type SubscriptionCallback = DocCallback<unknown> | QueryCallback<unknown>;

const subscriptionCallbacks = new Map<string, SubscriptionCallback>();

let subscriptionCounter = 0;

function generateSubscriptionId(): string {
  return `sub_${++subscriptionCounter}_${Date.now()}`;
}

/** パスからドキュメントIDを取得する */
function getDocIdFromPath(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1];
}

/** サブスクライブメッセージに含める databaseId（デフォルトデータベースは省略） */
function getSubscribeDatabaseId(firestore: Firestore): string | undefined {
  const databaseId = firestore._databaseId;
  return databaseId && databaseId !== "(default)" ? databaseId : undefined;
}

/** Firestoreインスタンスごとのスナップショットキャッシュ */
const snapshotCaches = new WeakMap<Firestore, SnapshotCache>();

function getSnapshotCache(firestore: Firestore): SnapshotCache {
  let cache = snapshotCaches.get(firestore);
  if (!cache) {
    cache = new SnapshotCache();
    snapshotCaches.set(firestore, cache);
  }
  return cache;
}

/**
 * LocalStore の変更イベントを doc リスナーへ配信する購読を（Firestore ごとに1回）設定する。
 * 書き込み API のローカル反映・サーバースナップショットの反映の両方がここを通る。
 */
const localStoreSubscribed = new WeakSet<Firestore>();

/**
 * サーバースナップショット処理中のサブスクリプションID。
 * LocalStore への一括反映が発する変更イベントで、当該クエリ自身が
 * ローカル再評価（不完全な membership 判定）してしまうのを防ぐ。
 */
let processingServerSnapshotFor: string | null = null;

function ensureLocalStoreSubscription(firestore: Firestore): void {
  if (localStoreSubscribed.has(firestore)) return;
  localStoreSubscribed.add(firestore);

  getLocalStore(firestore).onChange((changedPaths) => {
    for (const [subscriptionId, cb] of subscriptionCallbacks) {
      if (cb.kind === "doc") {
        const docCb = cb as DocCallback<unknown>;
        if (docCb.ref._firestore !== firestore) continue;
        if (!changedPaths.has(docCb.ref.path)) continue;
        emitComposedDocSnapshot(docCb, firestore);
      } else {
        const queryCb = cb as QueryCallback<unknown>;
        if (queryCb.firestore !== firestore) continue;
        if (subscriptionId === processingServerSnapshotFor) continue;
        const affected = [...changedPaths].filter((p) =>
          matchesCollection(p, queryCb.collectionPath, queryCb.collectionGroup),
        );
        if (affected.length === 0) continue;
        recomputeQueryLocally(queryCb, affected, firestore);
      }
    }
  });
}

/** 前回発火した結果集合と新しい結果集合から docChanges を合成する */
function computeQueryDiff(
  oldDocs: ReadonlyArray<EmittedQueryDoc>,
  newDocs: ReadonlyArray<EmittedQueryDoc>,
): Array<{ type: DocumentChangeType; doc: EmittedQueryDoc; oldIndex: number; newIndex: number }> {
  const changes: Array<{
    type: DocumentChangeType;
    doc: EmittedQueryDoc;
    oldIndex: number;
    newIndex: number;
  }> = [];
  const oldIndexByPath = new Map(oldDocs.map((d, i) => [d.path, i] as const));
  const newPaths = new Set(newDocs.map((d) => d.path));

  for (let i = 0; i < newDocs.length; i++) {
    const doc = newDocs[i];
    const oldIndex = oldIndexByPath.get(doc.path);
    if (oldIndex === undefined) {
      changes.push({ type: "added", doc, oldIndex: -1, newIndex: i });
    } else {
      const old = oldDocs[oldIndex];
      if (
        JSON.stringify(old.data) !== JSON.stringify(doc.data) ||
        old.updateTime !== doc.updateTime
      ) {
        changes.push({ type: "modified", doc, oldIndex, newIndex: i });
      }
    }
  }
  for (let i = 0; i < oldDocs.length; i++) {
    const doc = oldDocs[i];
    if (!newPaths.has(doc.path)) {
      changes.push({ type: "removed", doc, oldIndex: i, newIndex: -1 });
    }
  }
  return changes;
}

/** ワイヤ形式の EmittedQueryDoc から QueryDocumentSnapshot を構築する */
function buildQueryDocSnapshot(
  queryCb: QueryCallback<unknown>,
  doc: EmittedQueryDoc,
  fromCache: boolean,
): QueryDocumentSnapshot<DocumentData> {
  const fs = queryCb.firestore;
  const docId = getDocIdFromPath(doc.path);
  const metadata = new SnapshotMetadata(doc.hasPendingWrites, fromCache);
  let data = deserializeData(doc.data, fs);
  if (queryCb.converter) {
    const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
      doc.path,
      docId,
      data,
      doc.createTime ?? "",
      doc.updateTime ?? "",
      fs,
    );
    data = queryCb.converter.fromFirestore(rawSnapshot) as DocumentData;
  }
  return new QueryDocumentSnapshot(
    doc.path,
    docId,
    data,
    doc.createTime ?? "",
    doc.updateTime ?? "",
    fs,
    metadata,
  );
}

/**
 * クエリリスナーへ結果集合を発火する（サーバー / ローカル共通の統一パス）。
 * docChanges は常に前回発火した結果集合との差分で合成する。
 */
function emitQueryResult(
  queryCb: QueryCallback<unknown>,
  newDocs: EmittedQueryDoc[],
  fromCache: boolean,
): void {
  const changes = computeQueryDiff(queryCb.lastEmittedDocs ?? [], newDocs);
  const hasPendingWrites = newDocs.some((d) => d.hasPendingWrites);
  const metadataChanged =
    !queryCb.lastMetadata ||
    queryCb.lastMetadata.hasPendingWrites !== hasPendingWrites ||
    queryCb.lastMetadata.fromCache !== fromCache;

  const isFirstEmission = queryCb.lastEmittedDocs === undefined;
  if (!isFirstEmission && changes.length === 0) {
    // データ変更なし: metadata のみの変更は includeMetadataChanges 指定時のみ発火
    if (!metadataChanged || !queryCb.includeMetadataChanges) return;
  }

  queryCb.lastEmittedDocs = newDocs;
  queryCb.lastMetadata = { hasPendingWrites, fromCache };

  const docs = newDocs.map((d) => buildQueryDocSnapshot(queryCb, d, fromCache));
  const docByPath = new Map(docs.map((d) => [d.path, d] as const));
  const documentChanges: DocumentChange<DocumentData>[] = changes.map((ch) => ({
    type: ch.type,
    doc: docByPath.get(ch.doc.path) ?? buildQueryDocSnapshot(queryCb, ch.doc, fromCache),
    oldIndex: ch.oldIndex,
    newIndex: ch.newIndex,
  }));

  const snapshot = new QuerySnapshot(
    docs,
    documentChanges,
    queryCb.queryOrRef,
    new SnapshotMetadata(hasPendingWrites, fromCache),
  );
  queryCb.onNext(snapshot as QuerySnapshot<unknown>);
}

/**
 * ローカル変更（mutation の enqueue / ロールバック / 個別ドキュメントの確定）を
 * クエリ結果へ反映する。前回結果集合の該当パスをローカルビューで更新し、
 * クエリ制約（filter / orderBy / cursor / limit）を shared の QueryMatcher で再評価する。
 */
function recomputeQueryLocally(
  queryCb: QueryCallback<unknown>,
  affectedPaths: string[],
  firestore: Firestore,
): void {
  // 初回サーバースナップショット前は結果集合が不明なためローカル評価しない
  if (!queryCb.lastEmittedDocs) return;
  // findNearest（ベクトル距離順）はローカル評価できない
  if (queryCb.hasFindNearest) return;

  const localStore = getLocalStore(firestore);
  const candidates = new Map(queryCb.lastEmittedDocs.map((d) => [d.path, d] as const));

  for (const path of affectedPaths) {
    const composed = localStore.composeDocument(path);
    if (!composed) continue; // 状態不明のパスは前回の情報を維持
    if (composed.exists && composed.data) {
      candidates.set(path, {
        path,
        data: composed.data,
        createTime: composed.createTime,
        updateTime: composed.updateTime,
        hasPendingWrites: composed.hasPendingWrites,
      });
    } else {
      candidates.delete(path);
    }
  }

  const result = applyQueryConstraints(
    [...candidates.values()],
    queryCb.collectionPath,
    queryCb.collectionGroup,
    queryCb.constraints,
  );
  emitQueryResult(queryCb, result, !queryCb.receivedServerSnapshot);
}

/**
 * サーバーのクエリスナップショットを反映して発火する。
 * 受信結果を membership の正として、pending mutation の overlay を重ねる。
 */
function emitQueryFromServer(
  queryCb: QueryCallback<unknown>,
  serverDocs: ReadonlyArray<{
    path: string;
    data: DocumentData;
    createTime: string;
    updateTime: string;
  }>,
  firestore: Firestore,
): void {
  const localStore = getLocalStore(firestore);
  const candidates = new Map<string, EmittedQueryDoc>();

  for (const d of serverDocs) {
    const composed = localStore.composeDocument(d.path);
    if (composed && !composed.exists) continue; // pending delete は除外
    candidates.set(d.path, {
      path: d.path,
      data: composed?.data ?? d.data,
      createTime: d.createTime,
      updateTime: d.updateTime,
      hasPendingWrites: composed?.hasPendingWrites ?? false,
    });
  }

  // サーバー結果に含まれない pending write のドキュメントも候補に加える
  // （書き込み直後でまだサーバースナップショットに反映されていないもの）
  if (!queryCb.hasFindNearest) {
    for (const path of localStore.getPendingPaths()) {
      if (candidates.has(path)) continue;
      if (!matchesCollection(path, queryCb.collectionPath, queryCb.collectionGroup)) continue;
      const composed = localStore.composeDocument(path);
      if (composed?.exists && composed.data) {
        candidates.set(path, {
          path,
          data: composed.data,
          createTime: composed.createTime,
          updateTime: composed.updateTime,
          hasPendingWrites: composed.hasPendingWrites,
        });
      }
    }
  }

  // findNearest は距離順をローカルで再現できないためサーバー順をそのまま使う
  const result = queryCb.hasFindNearest
    ? serverDocs.map((d) => candidates.get(d.path)).filter((d): d is EmittedQueryDoc => !!d)
    : applyQueryConstraints(
        [...candidates.values()],
        queryCb.collectionPath,
        queryCb.collectionGroup,
        queryCb.constraints,
      );

  queryCb.receivedServerSnapshot = true;
  emitQueryResult(queryCb, result, false);
}

/**
 * ローカルビュー（サーバー確定値 + pending mutation の overlay）から
 * doc リスナーへスナップショットを発火する。
 *
 * - データが前回発火時と同じで metadata（hasPendingWrites / fromCache）のみ
 *   変化した場合は、includeMetadataChanges: true のリスナーにのみ発火する
 */
function emitComposedDocSnapshot(docCb: DocCallback<unknown>, firestore: Firestore): void {
  const composed: ComposedDocument | null = getLocalStore(firestore).composeDocument(
    docCb.ref.path,
  );
  if (!composed) return; // ドキュメントの状態が不明（初回スナップショット前の update 等）

  const dataJson = composed.exists ? JSON.stringify(composed.data) : "";
  const last = docCb.lastEmitted;
  // 本家同様、デフォルトのリスナーはデータ変更時のみ発火する
  // （同一データの再書き込みは updateTime が変わっても発火しない）
  const dataChanged = !last || last.exists !== composed.exists || last.dataJson !== dataJson;
  const metadataChanged =
    !last ||
    last.hasPendingWrites !== composed.hasPendingWrites ||
    last.fromCache !== composed.fromCache;

  if (!dataChanged && (!metadataChanged || !docCb.includeMetadataChanges)) {
    return;
  }

  docCb.lastEmitted = {
    exists: composed.exists,
    dataJson,
    updateTime: composed.updateTime,
    hasPendingWrites: composed.hasPendingWrites,
    fromCache: composed.fromCache,
  };

  let data: DocumentData | null = composed.exists
    ? deserializeData(composed.data as DocumentData, firestore)
    : null;
  if (data && docCb.converter) {
    const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
      docCb.ref.path,
      docCb.ref.id,
      data,
      composed.createTime ?? "",
      composed.updateTime ?? "",
      docCb.ref._firestore,
    );
    data = docCb.converter.fromFirestore(rawSnapshot) as DocumentData;
  }
  const metadata = new SnapshotMetadata(composed.hasPendingWrites, composed.fromCache);
  const snapshot = new DocumentSnapshotImpl(
    docCb.ref,
    data,
    composed.createTime,
    composed.updateTime,
    metadata,
  );
  docCb.onNext(snapshot);
}

function ensureMessageHandler(manager: ConnectionManager, firestore: Firestore): void {
  if (manager.hasMessageHandler) return;

  const cache = getSnapshotCache(firestore);
  const localStore = getLocalStore(firestore);

  manager.setMessageHandler((msg: ServerMessage) => {
    const cb = subscriptionCallbacks.get(msg.subscriptionId);
    if (!cb) return;

    switch (msg.type) {
      case "doc_snapshot": {
        if (cb.kind !== "doc") break;
        // サーバー確定値として LocalStore へ反映する。リスナーへの発火は
        // LocalStore の変更イベント経由（emitComposedDocSnapshot）で行われる
        localStore.applyRemoteDoc(msg.path, msg.exists, msg.data, msg.createTime, msg.updateTime);
        break;
      }
      case "query_snapshot": {
        if (cb.kind !== "query") break;
        const queryCb = cb as QueryCallback<unknown>;

        // クエリ結果をキャッシュ
        cache.putQuery(
          msg.subscriptionId,
          msg.docs.map((d) => ({
            path: d.path,
            exists: true,
            data: d.data,
            createTime: d.createTime,
            updateTime: d.updateTime,
            cachedAt: Date.now(),
          })),
        );

        // クエリ結果の各ドキュメントをサーバー確定値として LocalStore へ一括反映する
        // （同一パスの doc リスナーの発火・acknowledged mutation の解決に使われる）。
        // 一括反映が発する変更イベントで自分自身がローカル再評価しないようガードする
        processingServerSnapshotFor = msg.subscriptionId;
        try {
          localStore.applyRemoteDocs(
            msg.docs.map((d) => ({
              path: d.path,
              exists: true,
              data: d.data,
              createTime: d.createTime,
              updateTime: d.updateTime,
            })),
          );
        } finally {
          processingServerSnapshotFor = null;
        }

        // 受信結果を membership の正として overlay を重ねて発火する。
        // docChanges はサーバーの changes ではなく前回発火した結果集合との差分で
        // 合成する（再接続時のフル再購読も added / modified / removed の差分になる）
        emitQueryFromServer(queryCb, msg.docs, firestore);
        break;
      }
      case "error": {
        const error = new FirestoreError(msg.code as FirestoreErrorCode, msg.message);
        if (cb.kind === "doc") {
          const docCb = cb as DocCallback<unknown>;
          docCb.onError?.(error);
        } else {
          const queryCb = cb as QueryCallback<unknown>;
          queryCb.onError?.(error);
        }
        break;
      }
    }
  });
}

/**
 * ドキュメントリファレンスに対するリアルタイムリスナー
 */
export function onSnapshotDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
  options?: SnapshotListenOptions,
): Unsubscribe {
  const firestore = ref._firestore;
  assertNotTerminated(firestore);

  const subscriptionId = generateSubscriptionId();
  const localStore = getLocalStore(firestore);

  const docCb: DocCallback<unknown> = {
    kind: "doc",
    onNext: onNext as (snapshot: DocumentSnapshot<unknown>) => void,
    onError,
    ref: ref as DocumentReference<unknown>,
    converter: ref._converter as FirestoreDataConverter<unknown> | null,
    includeMetadataChanges: options?.includeMetadataChanges ?? false,
  };

  // source: 'cache' はサーバーへ購読せず、ローカルキャッシュの変化のみを配信する
  if (options?.source === "cache") {
    ensureLocalStoreSubscription(firestore);
    subscriptionCallbacks.set(subscriptionId, docCb);
    localStore.addDocInterest(ref.path);

    emitComposedDocSnapshot(docCb, firestore);
    if (!docCb.lastEmitted) {
      // キャッシュに状態がない場合も本家同様「存在しない」スナップショットを即時発火する
      docCb.lastEmitted = {
        exists: false,
        dataJson: "",
        updateTime: null,
        hasPendingWrites: false,
        fromCache: true,
      };
      onNext(new DocumentSnapshotImpl(ref, null, null, null, new SnapshotMetadata(false, true)));
    }

    return () => {
      subscriptionCallbacks.delete(subscriptionId);
      localStore.removeDocInterest(ref.path);
    };
  }

  const manager = getConnectionManager(firestore);
  ensureMessageHandler(manager, firestore);
  ensureLocalStoreSubscription(firestore);
  manager.connect();

  subscriptionCallbacks.set(subscriptionId, docCb);

  // acknowledged mutation の除去判定（サーバー反映の観測）に購読中パスを登録する
  localStore.addDocInterest(ref.path);

  // 既にローカルビューがある場合（pending write / キャッシュ済み）は即時発火する
  emitComposedDocSnapshot(docCb, firestore);

  // 認証トークンは送信のたびに取得する（再接続時にも最新のトークンが使われる）
  const buildMessage = async () =>
    JSON.stringify({
      type: "subscribe_doc",
      subscriptionId,
      path: ref.path,
      databaseId: getSubscribeDatabaseId(firestore),
      authToken: (await firestore._transport.getAuthToken()) ?? undefined,
    });

  manager.registerSubscription(subscriptionId, buildMessage);

  return () => {
    subscriptionCallbacks.delete(subscriptionId);
    manager.removeSubscription(subscriptionId);
    localStore.removeDocInterest(ref.path);
  };
}

/**
 * クエリに対するリアルタイムリスナー
 */
export function onSnapshotQuery<T = DocumentData>(
  queryOrRef: Query<T> | CollectionReference<T>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
  options?: SnapshotListenOptions,
): Unsubscribe {
  if (queryOrRef.type === "query") {
    validateConstraints(queryOrRef.constraints);
  }

  const firestore = queryOrRef._firestore;
  assertNotTerminated(firestore);

  const subscriptionId = generateSubscriptionId();

  let collectionPath: string;
  let collectionGroup: boolean;
  let constraints: SerializedQueryConstraint[];

  if (queryOrRef.type === "collection") {
    collectionPath = queryOrRef.path;
    collectionGroup = false;
    constraints = [];
  } else {
    collectionPath = queryOrRef.collectionPath;
    collectionGroup = queryOrRef.collectionGroup;
    constraints = queryOrRef.constraints;
  }

  const queryCb: QueryCallback<unknown> = {
    kind: "query",
    onNext: onNext as (snapshot: QuerySnapshot<unknown>) => void,
    onError,
    converter: (queryOrRef._converter ?? null) as FirestoreDataConverter<unknown> | null,
    firestore,
    queryOrRef: queryOrRef as Query<unknown> | CollectionReference<unknown>,
    collectionPath,
    collectionGroup,
    constraints,
    hasFindNearest: constraints.some((c) => c.type === "findNearest"),
    includeMetadataChanges: options?.includeMetadataChanges ?? false,
    receivedServerSnapshot: false,
  };

  // source: 'cache' はサーバーへ購読せず、ローカルキャッシュの変化のみを配信する
  if (options?.source === "cache") {
    if (queryCb.hasFindNearest) {
      throw new FirestoreError(
        "invalid-argument",
        "findNearest queries cannot be listened to from cache",
      );
    }
    ensureLocalStoreSubscription(firestore);
    subscriptionCallbacks.set(subscriptionId, queryCb);

    // 初回: ローカルストアが状態を知っている全ドキュメントから結果集合を合成する
    const localStore = getLocalStore(firestore);
    const candidates: EmittedQueryDoc[] = [];
    for (const path of localStore.getKnownPaths()) {
      if (!matchesCollection(path, collectionPath, collectionGroup)) continue;
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
    const result = applyQueryConstraints(candidates, collectionPath, collectionGroup, constraints);
    emitQueryResult(queryCb, result, true);

    return () => {
      subscriptionCallbacks.delete(subscriptionId);
    };
  }

  const manager = getConnectionManager(firestore);
  ensureMessageHandler(manager, firestore);
  ensureLocalStoreSubscription(firestore);
  manager.connect();

  subscriptionCallbacks.set(subscriptionId, queryCb);

  // 認証トークンは送信のたびに取得する（再接続時にも最新のトークンが使われる）
  const buildMessage = async () =>
    JSON.stringify({
      type: "subscribe_query",
      subscriptionId,
      collectionPath,
      collectionGroup,
      constraints,
      databaseId: getSubscribeDatabaseId(firestore),
      authToken: (await firestore._transport.getAuthToken()) ?? undefined,
    });

  manager.registerSubscription(subscriptionId, buildMessage);

  return () => {
    subscriptionCallbacks.delete(subscriptionId);
    manager.removeSubscription(subscriptionId);
  };
}

/**
 * Observer オブジェクト形式
 *
 * `complete` は呼び出されない。スナップショットのストリームは終了しないため、
 * 本家 Firebase SDK でも complete は呼ばれない仕様であり、型互換のためだけに存在する。
 */
export interface SnapshotObserver<S> {
  next?: (snapshot: S) => void;
  error?: (error: FirestoreError) => void;
  complete?: () => void;
}

/** リスナーのソース指定 */
export type ListenSource = "default" | "cache";

/**
 * リスナーオプション
 *
 * `includeMetadataChanges: true` を指定すると、データが同じで metadata
 * （hasPendingWrites / fromCache）のみ変化した場合にも発火する（本家互換）。
 * `source: 'cache'` を指定すると、サーバーへ購読せずローカルキャッシュ
 * （キャッシュ済みスナップショット + 保留中の書き込み）の変化のみを配信する。
 */
export interface SnapshotListenOptions {
  readonly includeMetadataChanges?: boolean;
  readonly source?: ListenSource;
}

/** 引数が SnapshotListenOptions かどうか判定する（observer / callback と区別） */
function isSnapshotListenOptions(value: unknown): value is SnapshotListenOptions {
  if (typeof value !== "object" || value === null) return false;
  return !("next" in value) && !("error" in value) && !("complete" in value);
}

/**
 * onSnapshot - Firebase互換のオーバーロード
 *
 * ドキュメントリファレンスまたはクエリに対してリアルタイムリスナーを設定する。
 */
export function onSnapshot<T = DocumentData>(
  ref: DocumentReference<T>,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  ref: DocumentReference<T>,
  observer: SnapshotObserver<DocumentSnapshot<T>>,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  ref: DocumentReference<T>,
  options: SnapshotListenOptions,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  ref: DocumentReference<T>,
  options: SnapshotListenOptions,
  observer: SnapshotObserver<DocumentSnapshot<T>>,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  query: Query<T> | CollectionReference<T>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  query: Query<T> | CollectionReference<T>,
  observer: SnapshotObserver<QuerySnapshot<T>>,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  query: Query<T> | CollectionReference<T>,
  options: SnapshotListenOptions,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  query: Query<T> | CollectionReference<T>,
  options: SnapshotListenOptions,
  observer: SnapshotObserver<QuerySnapshot<T>>,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  target: DocumentReference<T> | Query<T> | CollectionReference<T>,
  optionsOrOnNextOrObserver:
    | SnapshotListenOptions
    | ((snapshot: DocumentSnapshot<T>) => void)
    | ((snapshot: QuerySnapshot<T>) => void)
    | SnapshotObserver<DocumentSnapshot<T>>
    | SnapshotObserver<QuerySnapshot<T>>,
  ...rest: unknown[]
): Unsubscribe {
  // オプション形式の処理
  let onNextOrObserver:
    | ((snapshot: DocumentSnapshot<T>) => void)
    | ((snapshot: QuerySnapshot<T>) => void)
    | SnapshotObserver<DocumentSnapshot<T>>
    | SnapshotObserver<QuerySnapshot<T>>;
  let onError: ((error: FirestoreError) => void) | undefined;
  let listenOptions: SnapshotListenOptions | undefined;

  if (
    typeof optionsOrOnNextOrObserver !== "function" &&
    isSnapshotListenOptions(optionsOrOnNextOrObserver) &&
    rest[0] !== undefined
  ) {
    listenOptions = optionsOrOnNextOrObserver;
    onNextOrObserver = rest[0] as typeof onNextOrObserver;
    onError = rest[1] as ((error: FirestoreError) => void) | undefined;
  } else {
    onNextOrObserver = optionsOrOnNextOrObserver as typeof onNextOrObserver;
    onError = rest[0] as ((error: FirestoreError) => void) | undefined;
  }

  // Observer オブジェクト形式の処理
  let resolvedOnNext:
    | ((snapshot: DocumentSnapshot<T>) => void)
    | ((snapshot: QuerySnapshot<T>) => void);
  let resolvedOnError: ((error: FirestoreError) => void) | undefined;

  if (typeof onNextOrObserver === "function") {
    resolvedOnNext = onNextOrObserver;
    resolvedOnError = onError;
  } else {
    const observer = onNextOrObserver as SnapshotObserver<DocumentSnapshot<T>> &
      SnapshotObserver<QuerySnapshot<T>>;
    resolvedOnNext = observer.next
      ? (observer.next as (snapshot: DocumentSnapshot<T>) => void)
      : () => {};
    resolvedOnError = observer.error;
  }

  if (target.type === "document") {
    return onSnapshotDoc(
      target as DocumentReference<T>,
      resolvedOnNext as (snapshot: DocumentSnapshot<T>) => void,
      resolvedOnError,
      listenOptions,
    );
  }
  return onSnapshotQuery(
    target as Query<T> | CollectionReference<T>,
    resolvedOnNext as (snapshot: QuerySnapshot<T>) => void,
    resolvedOnError,
    listenOptions,
  );
}

/**
 * onSnapshotsInSync - 接続状態の同期リスナー
 *
 * 全てのスナップショットが同期されたときに呼ばれるリスナーを設定する。
 * 再接続後にサーバーからの初回スナップショットが全て受信された時点で通知される。
 */
export function onSnapshotsInSync(firestore: Firestore, callback: () => void): Unsubscribe {
  const manager = getConnectionManager(firestore);
  return manager.addStateListener((state) => {
    if (state === "connected") {
      callback();
    }
  });
}
