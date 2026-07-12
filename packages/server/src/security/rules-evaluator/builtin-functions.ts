import { documentValueToRulesValue } from "./special-types.js";
import type { RulesValue } from "./types.js";
import { mkBool, mkNull } from "./types.js";

/**
 * ドキュメント取得関数の型
 * SecurityRulesEngine から注入される
 */
export interface DocumentResolver {
  getDocument(path: string): Record<string, unknown> | null;
}

/**
 * 評価中の書き込み（バッチ / トランザクション / 単発書き込み）の
 * 「書き込み後の状態」。キーはドキュメントパス、値は書き込み適用後の
 * データ（削除は null）。getAfter() / existsAfter() が参照する。
 */
export type PendingWrites = ReadonlyMap<string, Record<string, unknown> | null>;

/**
 * get() / exists() の呼び出し回数制限
 */
const MAX_DOCUMENT_ACCESS_COUNT = 10;

/**
 * 組み込み関数の評価コンテキスト
 */
export class BuiltinFunctionContext {
  private documentAccessCount: number = 0;
  private resolver: DocumentResolver | null;
  private pendingWrites: PendingWrites | null = null;

  constructor(resolver: DocumentResolver | null) {
    this.resolver = resolver;
  }

  /** 評価開始時にカウンターをリセットし、書き込み後状態を差し替える */
  reset(pendingWrites: PendingWrites | null = null): void {
    this.documentAccessCount = 0;
    this.pendingWrites = pendingWrites;
  }

  /**
   * get(path) - ドキュメントを取得してデータを返す
   */
  get(args: RulesValue[]): RulesValue {
    if (args.length !== 1) throw new Error("get() expects 1 argument");
    const path = this.extractPath(args[0]);
    return this.fetchDocument(path) ?? mkNull();
  }

  /**
   * exists(path) - ドキュメントが存在するかチェック
   */
  exists(args: RulesValue[]): RulesValue {
    if (args.length !== 1) throw new Error("exists() expects 1 argument");
    const path = this.extractPath(args[0]);
    const doc = this.fetchDocument(path);
    return mkBool(doc !== null);
  }

  /**
   * getAfter(path) - 書き込み完了後の状態のドキュメントデータを返す
   * （バッチ書き込みの参照整合性検証の定石。本家互換）
   */
  getAfter(args: RulesValue[]): RulesValue {
    if (args.length !== 1) throw new Error("getAfter() expects 1 argument");
    const path = this.extractPath(args[0]);
    return this.fetchDocumentAfter(path) ?? mkNull();
  }

  /**
   * existsAfter(path) - 書き込み完了後にドキュメントが存在するかチェック
   */
  existsAfter(args: RulesValue[]): RulesValue {
    if (args.length !== 1) throw new Error("existsAfter() expects 1 argument");
    const path = this.extractPath(args[0]);
    const doc = this.fetchDocumentAfter(path);
    return mkBool(doc !== null);
  }

  /**
   * debug(value) - 値をログ出力してそのまま返す
   */
  debug(args: RulesValue[]): RulesValue {
    if (args.length !== 1) throw new Error("debug() expects 1 argument");
    // エミュレータ向け：コンソールに出力
    console.log("[firestore-rules-debug]", args[0]);
    return args[0];
  }

  private extractPath(val: RulesValue): string {
    if (val.typeName === "path") return val.value;
    if (val.typeName === "string") return val.value;
    throw new Error(`get/exists argument must be a path or string, got ${val.typeName}`);
  }

  private fetchDocument(path: string): RulesValue | null {
    this.documentAccessCount++;
    if (this.documentAccessCount > MAX_DOCUMENT_ACCESS_COUNT) {
      throw new Error(
        `Too many document access calls (max ${MAX_DOCUMENT_ACCESS_COUNT} per rule evaluation)`,
      );
    }

    if (!this.resolver) {
      throw new Error("Document resolver not configured. get()/exists() are not available.");
    }

    const data = this.resolver.getDocument(path);
    if (data === null) return null;
    return documentValueToRulesValue(data);
  }

  /** 書き込み後の状態でドキュメントを取得する（getAfter / existsAfter 用） */
  private fetchDocumentAfter(path: string): RulesValue | null {
    this.documentAccessCount++;
    if (this.documentAccessCount > MAX_DOCUMENT_ACCESS_COUNT) {
      throw new Error(
        `Too many document access calls (max ${MAX_DOCUMENT_ACCESS_COUNT} per rule evaluation)`,
      );
    }

    // 評価中の書き込みに含まれるパスは適用後の状態（削除は null）
    if (this.pendingWrites?.has(path)) {
      const data = this.pendingWrites.get(path) ?? null;
      return data === null ? null : documentValueToRulesValue(data);
    }

    // 書き込み対象外のドキュメントは現在の状態がそのまま「書き込み後の状態」
    if (!this.resolver) {
      throw new Error(
        "Document resolver not configured. getAfter()/existsAfter() are not available.",
      );
    }
    const data = this.resolver.getDocument(path);
    if (data === null) return null;
    return documentValueToRulesValue(data);
  }
}
