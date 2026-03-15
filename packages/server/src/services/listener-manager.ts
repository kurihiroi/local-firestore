import type {
  DocumentChangeData,
  DocumentChangeType,
  DocumentMetadata,
  QueryDocumentData,
  SerializedQueryConstraint,
} from "@local-firestore/shared";
import type { WebSocket } from "ws";
import type { QueryService } from "./query.js";

/** ドキュメントサブスクリプション */
interface DocSubscription {
  kind: "doc";
  subscriptionId: string;
  path: string;
  ws: WebSocket;
  /** 直前のスナップショット（exists判定用） */
  lastExists: boolean;
}

/** クエリサブスクリプション */
interface QuerySubscription {
  kind: "query";
  subscriptionId: string;
  collectionPath: string;
  collectionGroup: boolean;
  constraints: SerializedQueryConstraint[];
  ws: WebSocket;
  /** 直前のドキュメントパス一覧（change判定用） */
  lastDocs: QueryDocumentData[];
}

type Subscription = DocSubscription | QuerySubscription;

/**
 * アクティブなリスナーを管理し、ドキュメント変更時にスナップショットを配信する
 */
export class ListenerManager {
  private subscriptions = new Map<string, Subscription>();
  private wsSubs = new Map<WebSocket, Set<string>>();

  constructor(private queryService: QueryService) {}

  /** ドキュメントリスナーを登録し、初回スナップショットを送信する */
  subscribeDoc(
    ws: WebSocket,
    subscriptionId: string,
    path: string,
    getDocument: (path: string) => DocumentMetadata | undefined,
  ): void {
    const doc = getDocument(path);

    const sub: DocSubscription = {
      kind: "doc",
      subscriptionId,
      path,
      ws,
      lastExists: !!doc,
    };
    this.subscriptions.set(subscriptionId, sub);
    this.trackWs(ws, subscriptionId);

    // 初回スナップショット送信
    this.sendDocSnapshot(ws, subscriptionId, path, doc);
  }

  /** クエリリスナーを登録し、初回スナップショットを送信する */
  subscribeQuery(
    ws: WebSocket,
    subscriptionId: string,
    collectionPath: string,
    collectionGroup: boolean,
    constraints: SerializedQueryConstraint[],
  ): void {
    const docs = this.executeQuery(collectionPath, constraints, collectionGroup);

    const changes: DocumentChangeData[] = docs.map((d, i) => ({
      type: "added" as DocumentChangeType,
      path: d.path,
      data: d.data,
      createTime: d.createTime,
      updateTime: d.updateTime,
      oldIndex: -1,
      newIndex: i,
    }));

    const sub: QuerySubscription = {
      kind: "query",
      subscriptionId,
      collectionPath,
      collectionGroup,
      constraints,
      ws,
      lastDocs: docs,
    };
    this.subscriptions.set(subscriptionId, sub);
    this.trackWs(ws, subscriptionId);

    // 初回スナップショット送信
    this.sendQuerySnapshot(ws, subscriptionId, docs, changes);
  }

  /** リスナーを解除する */
  unsubscribe(subscriptionId: string): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (sub) {
      const wsSet = this.wsSubs.get(sub.ws);
      if (wsSet) {
        wsSet.delete(subscriptionId);
        if (wsSet.size === 0) {
          this.wsSubs.delete(sub.ws);
        }
      }
      this.subscriptions.delete(subscriptionId);
    }
  }

  /** WebSocket切断時に関連する全サブスクリプションを解除する */
  removeConnection(ws: WebSocket): void {
    const subIds = this.wsSubs.get(ws);
    if (subIds) {
      for (const id of subIds) {
        this.subscriptions.delete(id);
      }
      this.wsSubs.delete(ws);
    }
  }

  /**
   * ドキュメント変更を通知する。影響のあるリスナーにスナップショットを送信する。
   * DocumentService の書き込み操作後に呼び出す。
   */
  notifyChange(
    changedPath: string,
    getDocument: (path: string) => DocumentMetadata | undefined,
  ): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.ws.readyState !== 1 /* WebSocket.OPEN */) continue;

      if (sub.kind === "doc") {
        if (sub.path === changedPath) {
          const doc = getDocument(changedPath);
          sub.lastExists = !!doc;
          this.sendDocSnapshot(sub.ws, sub.subscriptionId, sub.path, doc);
        }
      } else {
        // クエリリスナー: 変更されたドキュメントが影響するかチェック
        if (this.queryMayBeAffected(sub, changedPath)) {
          const newDocs = this.executeQuery(
            sub.collectionPath,
            sub.constraints,
            sub.collectionGroup,
          );
          const changes = this.computeChanges(sub.lastDocs, newDocs);
          if (changes.length > 0) {
            sub.lastDocs = newDocs;
            this.sendQuerySnapshot(sub.ws, sub.subscriptionId, newDocs, changes);
          }
        }
      }
    }
  }

  /** アクティブなサブスクリプション数を返す */
  get size(): number {
    return this.subscriptions.size;
  }

  private trackWs(ws: WebSocket, subscriptionId: string): void {
    let set = this.wsSubs.get(ws);
    if (!set) {
      set = new Set();
      this.wsSubs.set(ws, set);
    }
    set.add(subscriptionId);
  }

  private executeQuery(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    collectionGroup: boolean,
  ): QueryDocumentData[] {
    const results = this.queryService.executeQuery(collectionPath, constraints, collectionGroup);
    return results.map((r) => ({
      path: r.path,
      data: r.data,
      createTime: r.createTime,
      updateTime: r.updateTime,
    }));
  }

  /** クエリに影響があるかの簡易判定 */
  private queryMayBeAffected(sub: QuerySubscription, changedPath: string): boolean {
    // パスからcollection_pathを抽出
    const segments = changedPath.split("/");
    if (segments.length < 2) return false;
    const docCollectionPath = segments.slice(0, -1).join("/");

    if (sub.collectionGroup) {
      // コレクショングループ: 末尾のコレクション名が一致すればOK
      const collectionName = docCollectionPath.split("/").pop();
      return collectionName === sub.collectionPath;
    }
    return docCollectionPath === sub.collectionPath;
  }

  /** 前回と今回のドキュメント一覧からchangesを計算する */
  private computeChanges(
    oldDocs: QueryDocumentData[],
    newDocs: QueryDocumentData[],
  ): DocumentChangeData[] {
    const changes: DocumentChangeData[] = [];
    const oldMap = new Map<string, { doc: QueryDocumentData; index: number }>();
    for (let i = 0; i < oldDocs.length; i++) {
      oldMap.set(oldDocs[i].path, { doc: oldDocs[i], index: i });
    }

    const newMap = new Map<string, { doc: QueryDocumentData; index: number }>();
    for (let i = 0; i < newDocs.length; i++) {
      newMap.set(newDocs[i].path, { doc: newDocs[i], index: i });
    }

    // added + modified
    for (let i = 0; i < newDocs.length; i++) {
      const newDoc = newDocs[i];
      const old = oldMap.get(newDoc.path);
      if (!old) {
        changes.push({
          type: "added",
          path: newDoc.path,
          data: newDoc.data,
          createTime: newDoc.createTime,
          updateTime: newDoc.updateTime,
          oldIndex: -1,
          newIndex: i,
        });
      } else if (
        old.doc.updateTime !== newDoc.updateTime ||
        JSON.stringify(old.doc.data) !== JSON.stringify(newDoc.data)
      ) {
        changes.push({
          type: "modified",
          path: newDoc.path,
          data: newDoc.data,
          createTime: newDoc.createTime,
          updateTime: newDoc.updateTime,
          oldIndex: old.index,
          newIndex: i,
        });
      }
    }

    // removed
    for (let i = 0; i < oldDocs.length; i++) {
      const oldDoc = oldDocs[i];
      if (!newMap.has(oldDoc.path)) {
        changes.push({
          type: "removed",
          path: oldDoc.path,
          data: oldDoc.data,
          createTime: oldDoc.createTime,
          updateTime: oldDoc.updateTime,
          oldIndex: i,
          newIndex: -1,
        });
      }
    }

    return changes;
  }

  private sendDocSnapshot(
    ws: WebSocket,
    subscriptionId: string,
    path: string,
    doc: DocumentMetadata | undefined,
  ): void {
    ws.send(
      JSON.stringify({
        type: "doc_snapshot",
        subscriptionId,
        exists: !!doc,
        path,
        data: doc?.data ?? null,
        createTime: doc?.createTime ?? null,
        updateTime: doc?.updateTime ?? null,
      }),
    );
  }

  private sendQuerySnapshot(
    ws: WebSocket,
    subscriptionId: string,
    docs: QueryDocumentData[],
    changes: DocumentChangeData[],
  ): void {
    ws.send(
      JSON.stringify({
        type: "query_snapshot",
        subscriptionId,
        docs,
        changes,
      }),
    );
  }
}
