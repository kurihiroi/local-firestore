import type { RulesValue } from "./types.js";
import { mkBool, mkNull, toRulesValue } from "./types.js";

/**
 * ドキュメント取得関数の型
 * SecurityRulesEngine から注入される
 */
export interface DocumentResolver {
  getDocument(path: string): Record<string, unknown> | null;
}

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

  constructor(resolver: DocumentResolver | null) {
    this.resolver = resolver;
  }

  /** 評価開始時にカウンターをリセット */
  reset(): void {
    this.documentAccessCount = 0;
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
    return toRulesValue(data);
  }
}
