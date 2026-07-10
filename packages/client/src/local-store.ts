import type {
  BatchResponse,
  DocumentData,
  SerializedTimestamp,
  SetDocumentResponse,
  SetOptions,
  UpdateDocumentResponse,
} from "@local-firestore/shared";
import {
  applySetMutation,
  applyUpdateMutation,
  type MutationContext,
} from "@local-firestore/shared";
import { logDebug } from "./logger.js";
import { isNetworkEnabled } from "./network-state.js";
import { FirestoreError } from "./transport.js";
import type { Firestore } from "./types.js";

/**
 * レイテンシ補償のローカルストア
 *
 * 書き込み API とリアルタイムリスナーを接続する「ローカルビュー」。
 * - MutationQueue: サーバー未確定の書き込み（pending mutation）を保持
 * - RemoteDocumentCache: サーバー確定スナップショットを保持
 * - 両者を overlay 合成したローカルビューをリスナーへ供給する
 *
 * mutation のライフサイクル:
 *   enqueue（即時ローカル反映） → pending → HTTP ack → acknowledged
 *   → 該当ドキュメントのサーバースナップショット観測（updateTime >= ack）で除去。
 *   リスナー未購読のパスはスナップショットが届かないため ack 時点で即除去する。
 *   HTTP 失敗時は mutation を除去してロールバックする。
 *
 * 設計: docs/2026-07-07-latency-compensation-design.md
 */

/** 書き込みオペレーション（ワイヤ形式のデータを保持） */
export interface MutationOperation {
  type: "set" | "update" | "delete";
  path: string;
  data?: DocumentData;
  options?: SetOptions;
}

/** ローカルビュー合成済みのドキュメント */
export interface ComposedDocument {
  path: string;
  exists: boolean;
  /** ワイヤ形式のデータ（exists: false のとき null） */
  data: DocumentData | null;
  createTime: string | null;
  updateTime: string | null;
  hasPendingWrites: boolean;
  /** サーバー確定値を一度も観測していない（pending mutation のみから合成した）場合 true */
  fromCache: boolean;
}

/** サーバー確定スナップショット */
interface RemoteDoc {
  exists: boolean;
  data: DocumentData | null;
  createTime: string | null;
  updateTime: string | null;
}

interface PendingMutation {
  batchId: number;
  operations: MutationOperation[];
  /** serverTimestamp のローカル推定解決に使うクライアント時刻 */
  localWriteTime: SerializedTimestamp;
  /** WriteBatch 由来（/batch エンドポイントで送信）か単発 API 由来か */
  endpoint: "direct" | "batch";
  state: "pending" | "acknowledged";
  sent: boolean;
  /** acknowledged 後: サーバーが返した updateTime（delete は undefined） */
  ackedUpdateTimes?: Map<string, string | undefined>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** ローカルビューの変更リスナー（変更されたドキュメントパスの集合を受け取る） */
export type LocalStoreChangeListener = (changedPaths: ReadonlySet<string>) => void;

function nowTimestamp(): SerializedTimestamp {
  const ms = Date.now();
  return {
    __type: "timestamp",
    value: { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 },
  };
}

function toFirestoreError(err: unknown): FirestoreError {
  if (err instanceof FirestoreError) return err;
  if (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    return new FirestoreError((err as { code: FirestoreError["code"] }).code, err.message);
  }
  return new FirestoreError("unknown", err instanceof Error ? err.message : String(err));
}

export class LocalStore {
  private remoteDocs = new Map<string, RemoteDoc>();
  private mutations: PendingMutation[] = [];
  private nextBatchId = 1;
  private changeListeners = new Set<LocalStoreChangeListener>();
  /** doc リスナーが購読中のパス（参照カウント） */
  private docInterest = new Map<string, number>();
  private flushing = false;

  constructor(private firestore: Firestore) {}

  // ──────────────────────────────────────────────
  // リスナー / 購読管理
  // ──────────────────────────────────────────────

  /** ローカルビューの変更リスナーを登録する */
  onChange(listener: LocalStoreChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** doc リスナーの購読開始を通知する（acknowledged mutation の除去判定に使用） */
  addDocInterest(path: string): void {
    this.docInterest.set(path, (this.docInterest.get(path) ?? 0) + 1);
  }

  /** doc リスナーの購読終了を通知する */
  removeDocInterest(path: string): void {
    const count = this.docInterest.get(path) ?? 0;
    if (count <= 1) {
      this.docInterest.delete(path);
      // 観測者がいなくなったパスの acknowledged mutation は除去できる
      this.releaseSettledMutations();
    } else {
      this.docInterest.set(path, count - 1);
    }
  }

  private isObserved(path: string): boolean {
    return this.docInterest.has(path);
  }

  // ──────────────────────────────────────────────
  // リモートキャッシュ
  // ──────────────────────────────────────────────

  /**
   * サーバー確定スナップショットを反映する（WebSocket / getDoc の結果）。
   * acknowledged mutation の除去判定を行い、変更をリスナーへ通知する。
   */
  applyRemoteDoc(
    path: string,
    exists: boolean,
    data: DocumentData | null,
    createTime: string | null,
    updateTime: string | null,
  ): void {
    this.remoteDocs.set(path, { exists, data, createTime, updateTime });
    const released = this.releaseSettledMutations();
    released.add(path);
    this.notify(released);
  }

  /** サーバー確定スナップショットを取得する（未観測なら undefined） */
  getRemoteDoc(path: string): RemoteDoc | undefined {
    return this.remoteDocs.get(path);
  }

  // ──────────────────────────────────────────────
  // ローカルビュー合成
  // ──────────────────────────────────────────────

  /**
   * リモートキャッシュに pending mutation を batchId 順に重ねたローカルビューを返す。
   *
   * @returns ドキュメントの状態が不明（リモート未観測かつ状態を確定させる
   *          mutation がない）場合は null
   */
  composeDocument(path: string): ComposedDocument | null {
    const remote = this.remoteDocs.get(path);
    let known = remote !== undefined;
    let exists = remote?.exists ?? false;
    let data: DocumentData | null = remote?.exists ? (remote.data ?? {}) : null;
    let hasPendingWrites = false;

    for (const mutation of this.mutations) {
      const ctx = this.contextFor(mutation);
      for (const op of mutation.operations) {
        if (op.path !== path) continue;
        hasPendingWrites = true;
        switch (op.type) {
          case "set":
            data = applySetMutation(exists ? data : null, op.data ?? {}, op.options, ctx);
            exists = true;
            known = true;
            break;
          case "update":
            // ベースが不明な update はローカルでは合成できない（サーバー確定を待つ）
            if (known && exists && data) {
              data = applyUpdateMutation(data, op.data ?? {}, ctx);
            }
            break;
          case "delete":
            exists = false;
            data = null;
            known = true;
            break;
        }
      }
    }

    if (!known) return null;
    return {
      path,
      exists,
      data,
      createTime: remote?.createTime ?? null,
      updateTime: remote?.updateTime ?? null,
      hasPendingWrites,
      fromCache: remote === undefined,
    };
  }

  private contextFor(mutation: PendingMutation): MutationContext {
    return {
      serverTimestamp: () => ({
        __type: "timestamp",
        value: { ...mutation.localWriteTime.value },
      }),
    };
  }

  // ──────────────────────────────────────────────
  // 書き込み（MutationQueue）
  // ──────────────────────────────────────────────

  /**
   * 書き込みミューテーションを登録する。
   *
   * ローカルビューへ即時反映してリスナーへ通知し、ネットワーク有効時は
   * サーバーへ送信する。返す Promise はサーバー確定（ack）で resolve、
   * 失敗（ロールバック）で reject する。
   *
   * ローカル適用が不正なミューテーション（merge なしの deleteField 等）は
   * 登録せずに同期的にエラーを投げる。
   */
  enqueue(operations: MutationOperation[], endpoint: "direct" | "batch" = "direct"): Promise<void> {
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const mutation: PendingMutation = {
      batchId: this.nextBatchId++,
      operations,
      localWriteTime: nowTimestamp(),
      endpoint,
      state: "pending",
      sent: false,
      promise,
      resolve,
      reject,
    };

    // 事前検証: ローカル適用でエラーになるミューテーション（deleteField の誤用等）は
    // 登録前に検出する（サーバーでも同じ検証があるが、ローカルビューを壊さないため）
    const ctx = this.contextFor(mutation);
    for (const op of operations) {
      const base = this.composeDocument(op.path);
      if (op.type === "set") {
        applySetMutation(base?.exists ? base.data : null, op.data ?? {}, op.options, ctx);
      } else if (op.type === "update" && base?.exists && base.data) {
        applyUpdateMutation(base.data, op.data ?? {}, ctx);
      }
    }

    this.mutations.push(mutation);
    this.notify(new Set(operations.map((op) => op.path)));
    void this.flush();
    return promise;
  }

  /**
   * 未送信のミューテーションを順番にサーバーへ送信する。
   * ネットワーク無効時は何もしない（enableNetwork() から再度呼ばれる）。
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (isNetworkEnabled(this.firestore)) {
        const next = this.mutations.find((m) => !m.sent);
        if (!next) break;
        next.sent = true;
        try {
          next.ackedUpdateTimes = await this.send(next);
          next.state = "acknowledged";
          next.resolve();
        } catch (err) {
          // 失敗した mutation はロールバック（除去して再合成）。後続は独立して送信する
          logDebug(`Mutation ${next.batchId} rejected, rolling back: ${String(err)}`);
          this.removeMutation(next);
          next.reject(toFirestoreError(err));
          continue;
        }
        const released = this.releaseSettledMutations();
        if (released.size > 0) this.notify(released);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 現時点でキューにある全ミューテーションの確定（ack または reject）を待つ。
   * 以降に登録された書き込みは待たない（本家 waitForPendingWrites と同じ）。
   */
  async waitForPendingWrites(): Promise<void> {
    const snapshot = this.mutations.map((m) => m.promise.catch(() => {}));
    await Promise.all(snapshot);
  }

  /** pending / acknowledged のミューテーション数（テスト・デバッグ用） */
  get pendingMutationCount(): number {
    return this.mutations.length;
  }

  /** キャッシュとキューをすべて破棄する（terminate / clearCache 用） */
  clear(): void {
    this.remoteDocs.clear();
    this.mutations = [];
  }

  private async send(mutation: PendingMutation): Promise<Map<string, string | undefined>> {
    const transport = this.firestore._transport;
    const acked = new Map<string, string | undefined>();

    if (mutation.endpoint === "batch" || mutation.operations.length > 1) {
      const res = await transport.post<BatchResponse>("/batch", {
        operations: mutation.operations,
      });
      for (const wr of res.writeResults ?? []) {
        acked.set(wr.path, wr.updateTime);
      }
      return acked;
    }

    const op = mutation.operations[0];
    switch (op.type) {
      case "set": {
        const res = await transport.put<SetDocumentResponse>(`/docs/${op.path}`, {
          data: op.data,
          options: op.options,
        });
        acked.set(op.path, res.updateTime);
        break;
      }
      case "update": {
        const res = await transport.patch<UpdateDocumentResponse>(`/docs/${op.path}`, {
          data: op.data,
        });
        acked.set(op.path, res.updateTime);
        break;
      }
      case "delete":
        await transport.delete(`/docs/${op.path}`);
        acked.set(op.path, undefined);
        break;
    }
    return acked;
  }

  private removeMutation(mutation: PendingMutation): void {
    const index = this.mutations.indexOf(mutation);
    if (index >= 0) {
      this.mutations.splice(index, 1);
      this.notify(new Set(mutation.operations.map((op) => op.path)));
    }
  }

  /**
   * acknowledged で「サーバー反映を観測済み（または観測者なし）」のミューテーションを
   * 除去する。除去により hasPendingWrites が変化したパスの集合を返す。
   */
  private releaseSettledMutations(): Set<string> {
    const released = new Set<string>();
    this.mutations = this.mutations.filter((m) => {
      if (m.state !== "acknowledged") return true;
      const settled = m.operations.every((op) => {
        if (!this.isObserved(op.path)) return true;
        const remote = this.remoteDocs.get(op.path);
        if (!remote) return false;
        if (op.type === "delete") return !remote.exists;
        const acked = m.ackedUpdateTimes?.get(op.path);
        return acked !== undefined && remote.updateTime !== null && remote.updateTime >= acked;
      });
      if (settled) {
        for (const op of m.operations) released.add(op.path);
        return false;
      }
      return true;
    });
    return released;
  }

  private notify(paths: Set<string>): void {
    if (paths.size === 0) return;
    for (const listener of this.changeListeners) {
      listener(paths);
    }
  }
}

/** Firestore インスタンスごとの LocalStore */
const localStores = new WeakMap<Firestore, LocalStore>();

export function getLocalStore(firestore: Firestore): LocalStore {
  let store = localStores.get(firestore);
  if (!store) {
    store = new LocalStore(firestore);
    localStores.set(firestore, store);
  }
  return store;
}
