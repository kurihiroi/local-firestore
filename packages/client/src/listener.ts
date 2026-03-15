import type {
  DocumentChangeData,
  DocumentData,
  FirestoreDataConverter,
  SerializedQueryConstraint,
  ServerMessage,
} from "@local-firestore/shared";
import type { Query } from "./query.js";
import { QueryDocumentSnapshot, QuerySnapshot } from "./snapshots.js";
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

/** WebSocket接続をFirestoreインスタンスごとに管理する */
const wsConnections = new WeakMap<Firestore, WebSocket>();

/** サブスクリプションIDごとのコールバック */
interface DocCallback<T = DocumentData> {
  kind: "doc";
  onNext: (snapshot: DocumentSnapshot<T>) => void;
  onError?: (error: Error) => void;
  ref: DocumentReference<T>;
  converter: FirestoreDataConverter<T> | null;
}

interface QueryCallback<T = DocumentData> {
  kind: "query";
  onNext: (snapshot: QuerySnapshot<T>) => void;
  onError?: (error: Error) => void;
  converter: FirestoreDataConverter<T> | null;
}

type SubscriptionCallback = DocCallback<unknown> | QueryCallback<unknown>;

const subscriptionCallbacks = new Map<string, SubscriptionCallback>();

let subscriptionCounter = 0;

function generateSubscriptionId(): string {
  return `sub_${++subscriptionCounter}_${Date.now()}`;
}

function getOrCreateWebSocket(firestore: Firestore): WebSocket {
  let ws = wsConnections.get(firestore);
  if (ws && ws.readyState <= 1 /* CONNECTING or OPEN */) {
    return ws;
  }

  const transport = firestore._transport;
  const wsUrl = transport.getWebSocketUrl();
  ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMessage;
    const cb = subscriptionCallbacks.get(msg.subscriptionId);
    if (!cb) return;

    switch (msg.type) {
      case "doc_snapshot": {
        if (cb.kind !== "doc") break;
        const docCb = cb as DocCallback<unknown>;
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
        if (cb.kind === "doc") {
          const docCb = cb as DocCallback<unknown>;
          docCb.onError?.(new Error(`[${msg.code}] ${msg.message}`));
        } else {
          const queryCb = cb as QueryCallback<unknown>;
          queryCb.onError?.(new Error(`[${msg.code}] ${msg.message}`));
        }
        break;
      }
    }
  };

  wsConnections.set(firestore, ws);
  return ws;
}

function sendWhenReady(ws: WebSocket, data: string): void {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(data);
  } else {
    ws.addEventListener("open", () => ws.send(data), { once: true });
  }
}

/**
 * ドキュメントリファレンスに対するリアルタイムリスナー
 */
export function onSnapshotDoc<T = DocumentData>(
  ref: DocumentReference<T>,
  onNext: (snapshot: DocumentSnapshot<T>) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  const firestore = ref._firestore;
  const ws = getOrCreateWebSocket(firestore);
  const subscriptionId = generateSubscriptionId();

  subscriptionCallbacks.set(subscriptionId, {
    kind: "doc",
    onNext: onNext as (snapshot: DocumentSnapshot<unknown>) => void,
    onError,
    ref: ref as DocumentReference<unknown>,
    converter: ref._converter as FirestoreDataConverter<unknown> | null,
  });

  sendWhenReady(
    ws,
    JSON.stringify({
      type: "subscribe_doc",
      subscriptionId,
      path: ref.path,
    }),
  );

  return () => {
    subscriptionCallbacks.delete(subscriptionId);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
    }
  };
}

/**
 * クエリに対するリアルタイムリスナー
 */
export function onSnapshotQuery<T = DocumentData>(
  queryOrRef: Query<T> | CollectionReference<T>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  const firestore = queryOrRef._firestore;
  const ws = getOrCreateWebSocket(firestore);
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

  sendWhenReady(
    ws,
    JSON.stringify({
      type: "subscribe_query",
      subscriptionId,
      collectionPath,
      collectionGroup,
      constraints,
    }),
  );

  return () => {
    subscriptionCallbacks.delete(subscriptionId);
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "unsubscribe", subscriptionId }));
    }
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
  onError?: (error: Error) => void,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  query: Query<T> | CollectionReference<T>,
  onNext: (snapshot: QuerySnapshot<T>) => void,
  onError?: (error: Error) => void,
): Unsubscribe;
export function onSnapshot<T = DocumentData>(
  target: DocumentReference<T> | Query<T> | CollectionReference<T>,
  onNext: ((snapshot: DocumentSnapshot<T>) => void) | ((snapshot: QuerySnapshot<T>) => void),
  onError?: (error: Error) => void,
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
