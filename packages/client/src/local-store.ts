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
import type { CacheStorageLike } from "./local-cache.js";
import { resolveCacheStorage } from "./local-cache.js";
import { logDebug } from "./logger.js";
import { isNetworkEnabled } from "./network-state.js";
import { FirestoreError, isTransientError } from "./transport.js";
import type { Firestore, PendingServerTimestampWire } from "./types.js";
import { isPendingServerTimestampWire } from "./types.js";

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
 *   HTTP 失敗時: 一過性エラー（unavailable / deadline-exceeded）は mutation を
 *   キューに保持したままバックオフ後に再送し、恒久エラーは除去してロールバックする。
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

/**
 * 一過性エラー時の再送バックオフ（transport 内の短期リトライが尽きた後の長期リトライ）。
 * 初期 1 秒から倍々で伸び、上限 30 秒。送信成功でリセットされる。
 */
const RETRY_INITIAL_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30000;

function nowTimestamp(): SerializedTimestamp {
  const ms = Date.now();
  return {
    __type: "timestamp",
    value: { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 },
  };
}

/** 永続キャッシュのストレージキー（データベースIDごとに分離） */
function cacheStorageKey(firestore: Firestore): string {
  return `local-firestore/cache/${firestore._databaseId ?? "(default)"}`;
}

/** 永続化される状態（JSON シリアライズ可能なワイヤ形式のみ） */
interface PersistedState {
  remoteDocs: Array<{
    path: string;
    exists: boolean;
    data: DocumentData | null;
    createTime: string | null;
    updateTime: string | null;
  }>;
  mutations: Array<{
    operations: MutationOperation[];
    localWriteTime: SerializedTimestamp;
    endpoint: "direct" | "batch";
  }>;
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
  /** 一過性エラー後の再送タイマー */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = RETRY_INITIAL_DELAY_MS;
  /** 永続キャッシュのストレージ（persistentLocalCache 設定時のみ） */
  private storage?: CacheStorageLike;
  private storageKey: string;
  /** 永続化失敗（quota 超過等）の警告を1回に抑えるフラグ */
  private persistWarned = false;

  constructor(private firestore: Firestore) {
    this.storageKey = cacheStorageKey(firestore);
    if (firestore._localCache?.kind === "persistent") {
      this.storage = resolveCacheStorage(firestore._localCache);
      this.restore();
    }
  }

  // ──────────────────────────────────────────────
  // 永続化（persistentLocalCache）
  // ──────────────────────────────────────────────

  /**
   * 永続化された状態（リモートキャッシュ + 未確定の保留書き込み）を復元する。
   * 復元した保留書き込みはネットワーク有効時に自動送信される。
   */
  private restore(): void {
    if (!this.storage) return;
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.storageKey);
    } catch {
      return;
    }
    if (!raw) return;

    let state: PersistedState;
    try {
      state = JSON.parse(raw) as PersistedState;
    } catch {
      logDebug("Persisted cache is corrupted; starting with an empty cache");
      return;
    }

    for (const doc of state.remoteDocs ?? []) {
      this.remoteDocs.set(doc.path, {
        exists: doc.exists,
        data: doc.data,
        createTime: doc.createTime,
        updateTime: doc.updateTime,
      });
    }

    for (const m of state.mutations ?? []) {
      let resolve!: () => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // 復元されたミューテーションは元の呼び出し元がいないため、
      // 拒否を unhandled rejection にしない
      promise.catch(() => {});
      this.mutations.push({
        batchId: this.nextBatchId++,
        operations: m.operations,
        localWriteTime: m.localWriteTime,
        endpoint: m.endpoint,
        state: "pending",
        sent: false,
        promise,
        resolve,
        reject,
      });
    }

    if (this.mutations.length > 0) {
      logDebug(`Restored ${this.mutations.length} pending write(s) from persisted cache`);
      // 復元した保留書き込みをバックグラウンドで送信する（本家の再起動時と同じ挙動）
      void this.flush();
    }
  }

  /** 現在の状態を永続化する（persistentLocalCache 設定時のみ） */
  private persist(): void {
    if (!this.storage) return;
    const state: PersistedState = {
      remoteDocs: [...this.remoteDocs.entries()].map(([path, doc]) => ({ path, ...doc })),
      // acknowledged はサーバー確定済みのため、未確定（pending）のみ永続化する
      mutations: this.mutations
        .filter((m) => m.state === "pending")
        .map((m) => ({
          operations: m.operations,
          localWriteTime: m.localWriteTime,
          endpoint: m.endpoint,
        })),
    };
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(state));
    } catch (err) {
      if (!this.persistWarned) {
        this.persistWarned = true;
        logDebug(`Failed to persist cache (storage quota?): ${String(err)}`);
      }
    }
  }

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

  /**
   * 複数のサーバー確定スナップショットをまとめて反映し、変更通知を1回にまとめる
   * （クエリスナップショット受信時に使用。ドキュメントごとの通知だと
   * クエリリスナーが結果1件ごとに再評価・発火してしまうため）。
   */
  applyRemoteDocs(
    docs: ReadonlyArray<{
      path: string;
      exists: boolean;
      data: DocumentData | null;
      createTime: string | null;
      updateTime: string | null;
    }>,
  ): void {
    for (const d of docs) {
      this.remoteDocs.set(d.path, {
        exists: d.exists,
        data: d.data,
        createTime: d.createTime,
        updateTime: d.updateTime,
      });
    }
    const released = this.releaseSettledMutations();
    for (const d of docs) released.add(d.path);
    this.notify(released);
  }

  /** サーバー確定スナップショットを取得する（未観測なら undefined） */
  getRemoteDoc(path: string): RemoteDoc | undefined {
    return this.remoteDocs.get(path);
  }

  /** pending / acknowledged mutation が書き込み対象にしているパスの集合を返す */
  getPendingPaths(): Set<string> {
    const paths = new Set<string>();
    for (const m of this.mutations) {
      for (const op of m.operations) paths.add(op.path);
    }
    return paths;
  }

  /**
   * ローカルストアが状態を知っている（キャッシュ済みまたは pending write のある）
   * 全ドキュメントパスの集合を返す（getDocsFromCache 用）。
   */
  getKnownPaths(): Set<string> {
    const paths = new Set<string>(this.remoteDocs.keys());
    for (const path of this.getPendingPaths()) paths.add(path);
    return paths;
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
      // serverTimestamp は保留中マーカーに解決し、スナップショットの
      // data(options) で serverTimestamps オプションに応じた値へ最終解決する
      serverTimestamp: (previousValue?: unknown): PendingServerTimestampWire => ({
        __type: "pendingServerTimestamp",
        estimate: { __type: "timestamp", value: { ...mutation.localWriteTime.value } },
        // 直前も保留中 serverTimestamp なら、その「確定済みの前回値」を引き継ぐ
        previous: isPendingServerTimestampWire(previousValue)
          ? previousValue.previous
          : (previousValue ?? null),
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
          this.retryDelayMs = RETRY_INITIAL_DELAY_MS;
          // ack 済みは永続化対象から外れる（release 前でも notify を経ないため明示）
          this.persist();
          next.resolve();
        } catch (err) {
          const error = toFirestoreError(err);
          if (isTransientError(error)) {
            // 一過性エラー: 書き込みを失わないよう mutation をキューに保持し、
            // バックオフ後に再送する。順序保証のため後続の送信も止める
            next.sent = false;
            logDebug(
              `Mutation ${next.batchId} failed transiently, will retry in ${this.retryDelayMs}ms: ${error.message}`,
            );
            this.scheduleRetryFlush();
            break;
          }
          // 恒久エラー: 失敗した mutation はロールバック（除去して再合成）。後続は独立して送信する
          logDebug(`Mutation ${next.batchId} rejected, rolling back: ${String(err)}`);
          this.removeMutation(next);
          next.reject(error);
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
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDelayMs = RETRY_INITIAL_DELAY_MS;
  }

  /** 一過性エラー後の再送をバックオフ付きでスケジュールする */
  private scheduleRetryFlush(): void {
    if (this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, RETRY_MAX_DELAY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
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
    this.persist();
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

/** @internal LocalStore が作成済みか（persistence API の開始前チェック用） */
export function hasLocalStore(firestore: Firestore): boolean {
  return localStores.has(firestore);
}

/** @internal 永続キャッシュのデータを削除する（clearIndexedDbPersistence 用） */
export function clearPersistedCache(firestore: Firestore): void {
  const cache = firestore._localCache;
  const storage = cache?.kind === "persistent" ? resolveCacheStorage(cache) : undefined;
  try {
    storage?.removeItem(cacheStorageKey(firestore));
  } catch {
    // ストレージ未対応環境では何もしない
  }
}
