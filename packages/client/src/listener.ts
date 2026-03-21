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
}

type SubscriptionCallback = DocCallback<unknown> | QueryCallback<unknown>;

const subscriptionCallbacks = new Map<string, SubscriptionCallback>();

let subscriptionCounter = 0;

function generateSubscriptionId(): string {
  return `sub_${++subscriptionCounter}_${Date.now()}`;
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

/** メッセージハンドラのセットアップ済みフラグ */
const handlerSetup = new WeakSet<ConnectionManager>();

function ensureMessageHandler(manager: ConnectionManager, firestore: Firestore): void {
  if (handlerSetup.has(manager)) return;
  handlerSetup.add(manager);

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

        let data: DocumentData | null = msg.exists ? (msg.data as DocumentData) : null;
        if (data && docCb.converter) {
          const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
            docCb.ref.path,
            docCb.ref.id,
            data,
            msg.createTime ?? "",
            msg.updateTime ?? "",
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
          const segments = d.path.split("/");
          const docId = segments[segments.length - 1];
          if (conv) {
            const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
              d.path,
              docId,
              d.data,
              d.createTime,
              d.updateTime,
            );
            const converted = conv.fromFirestore(rawSnapshot);
            return new QueryDocumentSnapshot(
              d.path,
              docId,
              converted as DocumentData,
              d.createTime,
              d.updateTime,
            );
          }
          return new QueryDocumentSnapshot(d.path, docId, d.data, d.createTime, d.updateTime);
        });
        const changes: DocumentChange<DocumentData>[] = msg.changes.map(
          (ch: DocumentChangeData) => {
            const segments = ch.path.split("/");
            const docId = segments[segments.length - 1];
            const rawData = ch.data ?? {};
            let docData: DocumentData = rawData;
            if (conv) {
              const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
                ch.path,
                docId,
                rawData,
                ch.createTime ?? "",
                ch.updateTime ?? "",
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
              ),
              oldIndex: ch.oldIndex,
              newIndex: ch.newIndex,
            };
          },
        );
        const snapshot = new QuerySnapshot(docs, changes);
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

  const message = JSON.stringify({
    type: "subscribe_doc",
    subscriptionId,
    path: ref.path,
  });

  manager.registerSubscription(subscriptionId, message);

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

  const message = JSON.stringify({
    type: "subscribe_query",
    subscriptionId,
    collectionPath,
    collectionGroup,
    constraints,
  });

  manager.registerSubscription(subscriptionId, message);

  return () => {
    subscriptionCallbacks.delete(subscriptionId);
    manager.removeSubscription(subscriptionId);
  };
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
  query: Query<T> | CollectionReference<T>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: FirestoreError) => void,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  target: DocumentReference<T> | Query<T> | CollectionReference<T>,
  onNext: ((snapshot: DocumentSnapshot<T>) => void) | ((snapshot: QuerySnapshot<T>) => void),
  onError?: (error: FirestoreError) => void,
): Unsubscribe {
  if (target.type === "document") {
    return onSnapshotDoc(
      target as DocumentReference<T>,
      onNext as (snapshot: DocumentSnapshot<T>) => void,
      onError,
    );
  }
  return onSnapshotQuery(
    target as Query<T> | CollectionReference<T>,
    onNext as (snapshot: QuerySnapshot<T>) => void,
    onError,
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
