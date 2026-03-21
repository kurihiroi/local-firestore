import type { DocumentData } from "@local-firestore/shared";

/** キャッシュされたドキュメントスナップショット */
export interface CachedDocument {
  path: string;
  exists: boolean;
  data: DocumentData | null;
  createTime: string | null;
  updateTime: string | null;
  cachedAt: number;
}

/** キャッシュされたクエリスナップショット */
export interface CachedQuery {
  key: string;
  docs: CachedDocument[];
  cachedAt: number;
}

/**
 * クライアント側スナップショットキャッシュ
 *
 * リアルタイムリスナーが受信したスナップショットをキャッシュし、
 * オフライン時に読み取りに使う。
 */
export class SnapshotCache {
  private documents = new Map<string, CachedDocument>();
  private queries = new Map<string, CachedQuery>();

  /** ドキュメントスナップショットをキャッシュ */
  putDocument(
    path: string,
    exists: boolean,
    data: DocumentData | null,
    createTime: string | null,
    updateTime: string | null,
  ): void {
    this.documents.set(path, {
      path,
      exists,
      data,
      createTime,
      updateTime,
      cachedAt: Date.now(),
    });
  }

  /** キャッシュされたドキュメントを取得 */
  getDocument(path: string): CachedDocument | undefined {
    return this.documents.get(path);
  }

  /** クエリスナップショットをキャッシュ */
  putQuery(key: string, docs: CachedDocument[]): void {
    this.queries.set(key, {
      key,
      docs,
      cachedAt: Date.now(),
    });
    // 個々のドキュメントもキャッシュ
    for (const doc of docs) {
      this.documents.set(doc.path, doc);
    }
  }

  /** キャッシュされたクエリを取得 */
  getQuery(key: string): CachedQuery | undefined {
    return this.queries.get(key);
  }

  /** ドキュメントキャッシュを削除 */
  removeDocument(path: string): void {
    this.documents.delete(path);
  }

  /** 全キャッシュをクリア */
  clear(): void {
    this.documents.clear();
    this.queries.clear();
  }

  /** キャッシュされたドキュメント数 */
  get documentCount(): number {
    return this.documents.size;
  }

  /** キャッシュされたクエリ数 */
  get queryCount(): number {
    return this.queries.size;
  }
}
