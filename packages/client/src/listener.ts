import type {
  DocumentChangeData,
  DocumentData,
  FirestoreDataConverter,
  FirestoreErrorCode,
  SerializedQueryConstraint,
  ServerMessage,
} from "@local-firestore/shared";
import { type ConnectionManager, getConnectionManager } from "./connection.js";
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
import { DocumentSnapshot as DocumentSnapshotImpl } from "./types.js";

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

function ensureMessageHandler(manager: ConnectionManager, firestore: Firestore): void {
  if (manager.hasMessageHandler) return;

  const cache = getSnapshotCache(firestore);

  manager.setMessageHandler((msg: ServerMessage) => {
    const cb = subscriptionCallbacks.get(msg.subscriptionId);
    if (!cb) return;

    switch (msg.type) {
      case "doc_snapshot": {
        if (cb.kind !== "doc") break;
        const docCb = cb as DocCallback<unknown>;

        // キャッシュに保存
        cache.putDocument(msg.path, msg.exists, msg.data, msg.createTime, msg.updateTime);

        let data: DocumentData | null = msg.exists
          ? deserializeData(msg.data as DocumentData, firestore)
          : null;
        if (data && docCb.converter) {
          const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
            docCb.ref.path,
            docCb.ref.id,
            data,
            msg.createTime ?? "",
            msg.updateTime ?? "",
            docCb.ref._firestore,
          );
          data = docCb.converter.fromFirestore(rawSnapshot) as DocumentData;
        }
        const snapshot = new DocumentSnapshotImpl(docCb.ref, data, msg.createTime, msg.updateTime);
        docCb.onNext(snapshot);
        break;
      }
      case "query_snapshot": {
        if (cb.kind !== "query") break;
        const queryCb = cb as QueryCallback<unknown>;
        const conv = queryCb.converter;
        const fs = queryCb.firestore;

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
): Unsubscribe {
  const firestore = ref._firestore;
  const manager = getConnectionManager(firestore);
  ensureMessageHandler(manager, firestore);
  manager.connect();

  const subscriptionId = generateSubscriptionId();

  subscriptionCallbacks.set(subscriptionId, {
    kind: "doc",
    onNext: onNext as (snapshot: DocumentSnapshot<unknown>) => void,
    onError,
    ref: ref as DocumentReference<unknown>,
    converter: ref._converter as FirestoreDataConverter<unknown> | null,
  });

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
 * ローカルエミュレータでは metadata（hasPendingWrites / fromCache）が変化しないため
 * `includeMetadataChanges` は no-op。`source` も常にサーバー配信のため no-op。
 * 本家 SDK からの移行コードが型エラーなく動作するために受け付ける。
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
  // オプション形式の処理（ローカルでは no-op のため読み飛ばすだけ）
  let onNextOrObserver:
    | ((snapshot: DocumentSnapshot<T>) => void)
    | ((snapshot: QuerySnapshot<T>) => void)
    | SnapshotObserver<DocumentSnapshot<T>>
    | SnapshotObserver<QuerySnapshot<T>>;
  let onError: ((error: FirestoreError) => void) | undefined;

  if (
    typeof optionsOrOnNextOrObserver !== "function" &&
    isSnapshotListenOptions(optionsOrOnNextOrObserver) &&
    rest[0] !== undefined
  ) {
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
