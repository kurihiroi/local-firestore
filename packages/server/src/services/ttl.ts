import type { DocumentMetadata } from "@local-firestore/shared";
import type { DocumentService } from "./document.js";

/** TTL ポリシーの定義 */
export interface TtlPolicy {
  /** 対象コレクションパス（ワイルドカード対応） */
  collectionPath: string;
  /** 期限を示す Timestamp フィールドのパス */
  timestampField: string;
}

/** TTL 削除結果 */
export interface TtlCleanupResult {
  deletedCount: number;
  deletedPaths: string[];
}

/**
 * TTL (Time-to-Live) サービス
 *
 * 指定フィールドの Timestamp を基に期限切れドキュメントを自動削除する。
 */
export class TtlService {
  private policies: TtlPolicy[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private documentService: DocumentService;
  private getDocuments: (collectionPath: string) => DocumentMetadata[];
  private onDocumentDeleted?: (path: string) => void;

  constructor(
    documentService: DocumentService,
    getDocuments: (collectionPath: string) => DocumentMetadata[],
    onDocumentDeleted?: (path: string) => void,
  ) {
    this.documentService = documentService;
    this.getDocuments = getDocuments;
    this.onDocumentDeleted = onDocumentDeleted;
  }

  /** TTL ポリシーを追加する */
  addPolicy(policy: TtlPolicy): void {
    this.policies.push(policy);
  }

  /** TTL ポリシーを削除する */
  removePolicy(collectionPath: string): boolean {
    const index = this.policies.findIndex((p) => p.collectionPath === collectionPath);
    if (index === -1) return false;
    this.policies.splice(index, 1);
    return true;
  }

  /** 登録済みポリシー数 */
  get policyCount(): number {
    return this.policies.length;
  }

  /** 定期クリーンアップを開始する */
  start(intervalMs: number = 60_000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.cleanup().catch((err) => {
        console.error("[TtlService] Cleanup error:", err);
      });
    }, intervalMs);
  }

  /** 定期クリーンアップを停止する */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 期限切れドキュメントをクリーンアップする */
  async cleanup(): Promise<TtlCleanupResult> {
    const now = Date.now();
    const deletedPaths: string[] = [];

    for (const policy of this.policies) {
      const docs = this.getDocuments(policy.collectionPath);
      for (const doc of docs) {
        if (this.isExpired(doc, policy.timestampField, now)) {
          this.documentService.deleteDocument(doc.path);
          this.onDocumentDeleted?.(doc.path);
          deletedPaths.push(doc.path);
        }
      }
    }

    return { deletedCount: deletedPaths.length, deletedPaths };
  }

  private isExpired(doc: DocumentMetadata, timestampField: string, nowMs: number): boolean {
    const value = this.resolveField(doc.data, timestampField);
    if (!value) return false;

    // SerializedTimestamp 形式の場合
    if (
      typeof value === "object" &&
      value !== null &&
      "__type" in value &&
      (value as Record<string, unknown>).__type === "timestamp"
    ) {
      const tsValue = (value as Record<string, unknown>).value as {
        seconds: number;
        nanoseconds: number;
      };
      const expiryMs = tsValue.seconds * 1000 + tsValue.nanoseconds / 1_000_000;
      return expiryMs <= nowMs;
    }

    // ISO 文字列の場合
    if (typeof value === "string") {
      const expiryMs = new Date(value).getTime();
      return !Number.isNaN(expiryMs) && expiryMs <= nowMs;
    }

    // ミリ秒数値の場合
    if (typeof value === "number") {
      return value <= nowMs;
    }

    return false;
  }

  private resolveField(data: Record<string, unknown>, fieldPath: string): unknown {
    const segments = fieldPath.split(".");
    let current: unknown = data;
    for (const segment of segments) {
      if (current === null || current === undefined || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }
}
