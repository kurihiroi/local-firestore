import type {
  DocumentChangeData,
  DocumentChangeType,
  DocumentMetadata,
  QueryDocumentData,
  SerializedQueryConstraint,
} from "@local-firestore/shared";
import { applyQueryConstraints, matchesQueryFilters } from "@local-firestore/shared";
import type { WebSocket } from "ws";
import type { QueryService } from "./query.js";

/**
 * クエリサブスクリプションに対するセキュリティルールガード。
 * 渡されたドキュメント群を list ルールで評価し、
 * 許可なら null、拒否なら理由文字列を返す。
 */
export type QueryRulesGuard = (docs: QueryDocumentData[]) => string | null;

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
  /** lastDocs のパス集合（影響判定の O(1) 化） */
  lastPathSet: Set<string>;
  /**
   * SQL 再実行なしの増分更新が可能か。limit / limitToLast は結果集合外の
   * ドキュメントの繰り上がりが起きるため不可、findNearest はローカル評価
   * 非対応のため不可（登録時に判定してキャッシュ）。
   */
  incremental: boolean;
  /** セキュリティルールガード（per-document 評価が必要な場合のみ設定される） */
  guard?: QueryRulesGuard;
}

type Subscription = DocSubscription | QuerySubscription;

/** 送信バッファ上限のデフォルト（16 MiB） */
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export interface ListenerManagerOptions {
  /**
   * 送信バッファ（ws.bufferedAmount）の上限バイト数。超過した遅い接続は
   * 切断され、メモリの積み上がりを防ぐ（`WS_MAX_BUFFERED_BYTES`）。0 で無効。
   */
  maxBufferedBytes?: number;
}

/**
 * アクティブなリスナーを管理し、ドキュメント変更時にスナップショットを配信する
 */
export class ListenerManager {
  private subscriptions = new Map<string, Subscription>();
  private wsSubs = new Map<WebSocket, Set<string>>();
  private maxBufferedBytes: number;

  constructor(
    private queryService: QueryService,
    options: ListenerManagerOptions = {},
  ) {
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  /** アクティブな購読数（メトリクス用） */
  get subscriptionCount(): number {
    return this.subscriptions.size;
  }

  /** 購読を持つ WebSocket 接続数（メトリクス用） */
  get connectionCount(): number {
    return this.wsSubs.size;
  }

  /**
   * バックプレッシャ検査。送信バッファが上限を超えた遅い接続は切断して
   * false を返す（購読のクリーンアップは close イベント経由の
   * removeConnection に任せる）。
   */
  private ensureWritable(ws: WebSocket): boolean {
    if (this.maxBufferedBytes > 0 && (ws.bufferedAmount ?? 0) > this.maxBufferedBytes) {
      ws.terminate();
      return false;
    }
    return true;
  }

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
    guard?: QueryRulesGuard,
  ): void {
    const docs = this.executeQuery(collectionPath, constraints, collectionGroup);

    // 初回スナップショットを per-document 評価し、拒否があれば購読を開始しない
    if (guard) {
      const deniedReason = guard(docs);
      if (deniedReason !== null) {
        this.sendPermissionDenied(ws, subscriptionId, deniedReason);
        return;
      }
    }

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
      lastPathSet: new Set(docs.map((d) => d.path)),
      incremental: !constraints.some(
        (c) => c.type === "limit" || c.type === "limitToLast" || c.type === "findNearest",
      ),
      guard,
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
    this.notifyChanges([changedPath], getDocument);
  }

  /**
   * 複数ドキュメントの変更をまとめて通知する（バッチ / トランザクション書き込み用）。
   *
   * 各サブスクリプションは変更パス数によらず最大1回だけ再評価される:
   * - 影響判定: 変更ドキュメントが「現在の結果集合に含まれる」または
   *   「クエリのフィルタにマッチする」場合のみ再評価する（それ以外は SQL も
   *   差分計算も行わずスキップ）
   * - 増分更新: limit / findNearest を含まないクエリは、保持している結果集合に
   *   変更ドキュメントだけを適用してローカルで再計算する（SQL 再実行なし）
   * - フォールバック: limit 付き等は従来どおり SQL を1回再実行する
   */
  notifyChanges(
    changedPaths: Iterable<string>,
    getDocument: (path: string) => DocumentMetadata | undefined,
  ): void {
    const paths = [...new Set(changedPaths)];
    if (paths.length === 0) return;

    // 変更ドキュメントの現在値をパスごとに1回だけ取得して全購読で共有する
    const changedDocs = new Map<string, DocumentMetadata | undefined>();
    for (const path of paths) {
      changedDocs.set(path, getDocument(path));
    }

    for (const sub of this.subscriptions.values()) {
      if (sub.ws.readyState !== 1 /* WebSocket.OPEN */) continue;

      if (sub.kind === "doc") {
        if (changedDocs.has(sub.path)) {
          const doc = changedDocs.get(sub.path);
          sub.lastExists = !!doc;
          this.sendDocSnapshot(sub.ws, sub.subscriptionId, sub.path, doc);
        }
      } else {
        this.notifyQuerySubscription(sub, paths, changedDocs);
      }
    }
  }

  /** クエリ購読1件に対する変更適用（影響判定 → 増分更新 or SQL 再実行 → 差分送信） */
  private notifyQuerySubscription(
    sub: QuerySubscription,
    paths: string[],
    changedDocs: Map<string, DocumentMetadata | undefined>,
  ): void {
    // 影響しうる変更パスの抽出。結果集合に含まれず、クエリのフィルタにも
    // マッチしないドキュメントの変更はこの購読に影響しない
    const affected: string[] = [];
    for (const path of paths) {
      if (!this.queryMayBeAffected(sub, path)) continue;
      if (sub.lastPathSet.has(path)) {
        affected.push(path);
        continue;
      }
      const doc = changedDocs.get(path);
      if (
        doc &&
        matchesQueryFilters(doc, sub.collectionPath, sub.collectionGroup, sub.constraints)
      ) {
        affected.push(path);
      }
    }
    if (affected.length === 0) return;

    let newDocs: QueryDocumentData[];
    if (sub.incremental) {
      // 増分更新: 保持している結果集合から変更パスを除き、現在値を加えて
      // ローカルでクエリ制約を再適用する（フィルタ・カーソル・ソートを含む）
      const affectedSet = new Set(affected);
      const candidates: QueryDocumentData[] = sub.lastDocs.filter((d) => !affectedSet.has(d.path));
      for (const path of affected) {
        const doc = changedDocs.get(path);
        if (doc) {
          candidates.push({
            path: doc.path,
            data: doc.data,
            createTime: doc.createTime,
            updateTime: doc.updateTime,
          });
        }
      }
      newDocs = applyQueryConstraints(
        candidates,
        sub.collectionPath,
        sub.collectionGroup,
        sub.constraints,
      );
    } else {
      newDocs = this.executeQuery(sub.collectionPath, sub.constraints, sub.collectionGroup);
    }

    const changes = this.computeChanges(sub.lastDocs, newDocs);
    if (changes.length === 0) return;

    // 追加・変更されたドキュメントをルール評価し、拒否に転じた場合は
    // permission-denied を送って購読を終了する（本家と同じ挙動）
    if (sub.guard) {
      const changedInResult = new Set(
        changes.filter((c) => c.type !== "removed").map((c) => c.path),
      );
      const docsToCheck = newDocs.filter((d) => changedInResult.has(d.path));
      if (docsToCheck.length > 0) {
        const deniedReason = sub.guard(docsToCheck);
        if (deniedReason !== null) {
          this.unsubscribe(sub.subscriptionId);
          this.sendPermissionDenied(sub.ws, sub.subscriptionId, deniedReason);
          return;
        }
      }
    }
    sub.lastDocs = newDocs;
    sub.lastPathSet = new Set(newDocs.map((d) => d.path));
    this.sendQuerySnapshot(sub.ws, sub.subscriptionId, newDocs, changes);
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
      } else if (old.doc === newDoc) {
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
    if (!this.ensureWritable(ws)) return;
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

  private sendPermissionDenied(ws: WebSocket, subscriptionId: string, message: string): void {
    if (ws.readyState !== 1 /* WebSocket.OPEN */) return;
    if (!this.ensureWritable(ws)) return;
    ws.send(
      JSON.stringify({
        type: "error",
        subscriptionId,
        code: "permission-denied",
        message,
      }),
    );
  }

  private sendQuerySnapshot(
    ws: WebSocket,
    subscriptionId: string,
    docs: QueryDocumentData[],
    changes: DocumentChangeData[],
  ): void {
    if (!this.ensureWritable(ws)) return;
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
