import type {
  DocumentChangeData,
  DocumentData,
  FirestoreDataConverter,
  FirestoreErrorCode,
  SerializedQueryConstraint,
  ServerMessage,
} from "@local-firestore/shared";
import { type ConnectionManager, getConnectionManager } from "./connection.js";
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

interface QueryCallback<T = DocumentData> {
  kind: "query";
  onNext: (snapshot: QuerySnapshot<T>) => void;
  onError?: (error: FirestoreError) => void;
  converter: FirestoreDataConverter<T> | null;
  firestore: Firestore;
  queryOrRef: Query<T> | CollectionReference<T>;
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

function ensureLocalStoreSubscription(firestore: Firestore): void {
  if (localStoreSubscribed.has(firestore)) return;
  localStoreSubscribed.add(firestore);

  getLocalStore(firestore).onChange((changedPaths) => {
    for (const cb of subscriptionCallbacks.values()) {
      if (cb.kind !== "doc") continue;
      const docCb = cb as DocCallback<unknown>;
      if (docCb.ref._firestore !== firestore) continue;
      if (!changedPaths.has(docCb.ref.path)) continue;
      emitComposedDocSnapshot(docCb, firestore);
    }
  });
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
        const conv = queryCb.converter;
        const fs = queryCb.firestore;

        // クエリ結果の各ドキュメントもサーバー確定値として LocalStore へ反映する
        // （同一パスの doc リスナーの発火・acknowledged mutation の解決に使われる）
        for (const d of msg.docs) {
          localStore.applyRemoteDoc(d.path, true, d.data, d.createTime, d.updateTime);
        }

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

        const docs = msg.docs.map((d) => {
          const docId = getDocIdFromPath(d.path);
          const revived = deserializeData(d.data, fs);
          if (conv) {
            const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
              d.path,
              docId,
              revived,
              d.createTime,
              d.updateTime,
              fs,
            );
            const converted = conv.fromFirestore(rawSnapshot);
            return new QueryDocumentSnapshot(
              d.path,
              docId,
              converted as DocumentData,
              d.createTime,
              d.updateTime,
              fs,
            );
          }
          return new QueryDocumentSnapshot(d.path, docId, revived, d.createTime, d.updateTime, fs);
        });
        const changes: DocumentChange<DocumentData>[] = msg.changes.map(
          (ch: DocumentChangeData) => {
            const docId = getDocIdFromPath(ch.path);
            const rawData = deserializeData(ch.data ?? {}, fs);
            let docData: DocumentData = rawData;
            if (conv) {
              const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
                ch.path,
                docId,
                rawData,
                ch.createTime ?? "",
                ch.updateTime ?? "",
                fs,
              );
              docData = conv.fromFirestore(rawSnapshot) as DocumentData;
            }
            return {
              type: ch.type,
              doc: new QueryDocumentSnapshot(
                ch.path,
                docId,
                docData,
                ch.createTime ?? "",
                ch.updateTime ?? "",
                fs,
              ),
              oldIndex: ch.oldIndex,
              newIndex: ch.newIndex,
            };
          },
        );
        const snapshot = new QuerySnapshot(docs, changes, queryCb.queryOrRef);
        queryCb.onNext(snapshot);
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
  const manager = getConnectionManager(firestore);
  ensureMessageHandler(manager, firestore);
  ensureLocalStoreSubscription(firestore);
  manager.connect();

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
): Unsubscribe {
  if (queryOrRef.type === "query") {
    validateConstraints(queryOrRef.constraints);
  }

  const firestore = queryOrRef._firestore;
  const manager = getConnectionManager(firestore);
  ensureMessageHandler(manager, firestore);
  manager.connect();

  const subscriptionId = generateSubscriptionId();

  subscriptionCallbacks.set(subscriptionId, {
    kind: "query",
    onNext: onNext as (snapshot: QuerySnapshot<unknown>) => void,
    onError,
    converter: (queryOrRef._converter ?? null) as FirestoreDataConverter<unknown> | null,
    firestore,
    queryOrRef: queryOrRef as Query<unknown> | CollectionReference<unknown>,
  });

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

/** リスナーのソース指定（ローカルでは常にサーバーから配信されるため実質 no-op） */
export type ListenSource = "default" | "cache";

/**
 * リスナーオプション
 *
 * `includeMetadataChanges: true` を指定すると、データが同じで metadata
 * （hasPendingWrites / fromCache）のみ変化した場合にも発火する（本家互換）。
 * `source` は常にサーバー配信のため no-op（型互換のために受け付ける）。
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
