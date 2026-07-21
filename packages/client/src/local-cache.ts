import { logDebug } from "./logger.js";

/**
 * ローカルキャッシュ設定（本家 `firebase/firestore` の
 * `memoryLocalCache` / `persistentLocalCache` 互換 API）
 *
 * 本家は IndexedDB を使うが、local-firestore クライアントは同期設計の
 * ローカルストアに合わせて Web Storage 互換の同期キー・バリューストア
 * （デフォルト: `globalThis.localStorage`）へ永続化する。
 * Node.js などストレージがない環境では自動的にインメモリへフォールバックする。
 */

/** Web Storage 互換の同期キー・バリューストア */
export interface CacheStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 永続キャッシュのタブ間協調設定（本家互換の型。ローカルでは区別しない） */
export interface PersistentTabManager {
  readonly kind: "persistentSingleTab" | "persistentMultipleTab";
}

/** インメモリキャッシュ設定（デフォルト） */
export interface MemoryLocalCache {
  readonly kind: "memory";
}

/** 永続キャッシュ設定 */
export interface PersistentLocalCache {
  readonly kind: "persistent";
  /** @internal 永続化先ストレージ（未指定時は globalThis.localStorage） */
  readonly _storage?: CacheStorageLike;
  /** @internal 本家互換のため保持する（ローカルでは挙動に影響しない） */
  readonly _tabManager?: PersistentTabManager;
}

export type FirestoreLocalCache = MemoryLocalCache | PersistentLocalCache;

/** キャッシュサイズ無制限（本家互換の定数。ローカルではサイズ制限自体がない） */
export const CACHE_SIZE_UNLIMITED = -1;

/** `persistentLocalCache()` の設定 */
export interface PersistentCacheSettings {
  /** 本家互換のため受け付けるが、ローカルではサイズ制限は行わない */
  cacheSizeBytes?: number;
  tabManager?: PersistentTabManager;
  /**
   * 永続化先ストレージ（local-firestore 拡張）。
   * 未指定時は `globalThis.localStorage`、それも無い環境ではインメモリ動作になる。
   */
  storage?: CacheStorageLike;
}

/** インメモリキャッシュ設定を作成する（デフォルト動作と同じ） */
export function memoryLocalCache(): MemoryLocalCache {
  return { kind: "memory" };
}

/** 永続キャッシュ設定を作成する */
export function persistentLocalCache(settings?: PersistentCacheSettings): PersistentLocalCache {
  if (settings?.cacheSizeBytes !== undefined) {
    logDebug("persistentLocalCache: cacheSizeBytes is accepted for compatibility but ignored");
  }
  return {
    kind: "persistent",
    _storage: settings?.storage,
    _tabManager: settings?.tabManager,
  };
}

/** シングルタブ用タブマネージャ（本家互換。ローカルでは挙動に影響しない） */
export function persistentSingleTabManager(
  _settings?: { forceOwnership?: boolean } | undefined,
): PersistentTabManager {
  return { kind: "persistentSingleTab" };
}

/** マルチタブ用タブマネージャ（本家互換。ローカルでは挙動に影響しない） */
export function persistentMultipleTabManager(): PersistentTabManager {
  return { kind: "persistentMultipleTab" };
}

/** 永続キャッシュ設定から実際に使うストレージを解決する（無ければ undefined） */
export function resolveCacheStorage(cache: PersistentLocalCache): CacheStorageLike | undefined {
  if (cache._storage) return cache._storage;
  const globalStorage = (globalThis as { localStorage?: CacheStorageLike }).localStorage;
  if (globalStorage) return globalStorage;
  logDebug(
    "persistentLocalCache: no storage available in this environment; falling back to memory cache",
  );
  return undefined;
}
