import type { DocumentData } from "@local-firestore/shared";

/** 操作の種類 */
export type Operation = "read" | "get" | "list" | "write" | "create" | "update" | "delete";

/** セキュリティルール定義 */
export interface SecurityRules {
  rules: CollectionRules;
}

/** コレクション別のルール定義 */
export interface CollectionRules {
  [collectionPattern: string]: CollectionRule;
}

/** 単一コレクションのルール */
export interface CollectionRule {
  /** 読み取り許可（get + list のショートカット） */
  read?: boolean | string;
  /** 書き込み許可（create + update + delete のショートカット） */
  write?: boolean | string;
  /** 単一ドキュメント取得の許可 */
  get?: boolean | string;
  /** コレクション一覧取得の許可 */
  list?: boolean | string;
  /** ドキュメント新規作成の許可 */
  create?: boolean | string;
  /** ドキュメント更新の許可 */
  update?: boolean | string;
  /** ドキュメント削除の許可 */
  delete?: boolean | string;
  /** サブコレクションのルール */
  subcollections?: CollectionRules;
}

/** ルール評価に使うコンテキスト */
export interface RuleContext {
  /** 認証情報（ヘッダーなどから取得） */
  auth: AuthContext | null;
  /** 操作対象のドキュメントパス */
  path: string;
  /** ドキュメントID */
  documentId: string;
  /** コレクションパス */
  collectionPath: string;
  /** リクエストデータ（書き込み操作時） */
  requestData?: DocumentData;
  /** 既存のドキュメントデータ（更新・削除時） */
  existingData?: DocumentData;
}

/** 認証コンテキスト */
export interface AuthContext {
  uid: string;
  [key: string]: unknown;
}

/** ルール評価結果 */
export interface RuleEvaluationResult {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

/**
 * セキュリティルールエンジン
 *
 * Firebaseセキュリティルールの簡易版。
 * JSONベースのルール定義でドキュメントへのアクセスを制御する。
 */
export class SecurityRulesEngine {
  private rules: SecurityRules;

  constructor(rules: SecurityRules) {
    this.rules = rules;
  }

  /**
   * 指定された操作が許可されるか評価する
   */
  evaluate(operation: Operation, context: RuleContext): RuleEvaluationResult {
    const segments = context.collectionPath.split("/");
    let currentRules = this.rules.rules;
    let matchedRule: CollectionRule | undefined;

    // コレクションパスに沿ってルールを探索
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      // 完全一致を優先、なければワイルドカード
      if (currentRules[segment]) {
        matchedRule = currentRules[segment];
      } else if (currentRules["{collection}"]) {
        matchedRule = currentRules["{collection}"];
      } else {
        // ルールが見つからない場合はデフォルト拒否
        return {
          allowed: false,
          reason: `No rule found for collection: ${context.collectionPath}`,
        };
      }

      // 次のサブコレクション層へ進む（奇数インデックスはドキュメントID部分をスキップ）
      if (i < segments.length - 1 && matchedRule.subcollections) {
        currentRules = matchedRule.subcollections;
        matchedRule = undefined;
      }
    }

    if (!matchedRule) {
      return { allowed: false, reason: `No rule found for collection: ${context.collectionPath}` };
    }

    // 操作に対応するルールを取得
    const ruleValue = this.resolveOperationRule(matchedRule, operation);
    if (ruleValue === undefined) {
      return { allowed: false, reason: `No rule defined for operation: ${operation}` };
    }

    // boolean値の場合はそのまま
    if (typeof ruleValue === "boolean") {
      return { allowed: ruleValue, rule: String(ruleValue) };
    }

    // 文字列の場合は式として評価
    const allowed = this.evaluateExpression(ruleValue, context);
    return { allowed, rule: ruleValue };
  }

  /**
   * 操作に対応するルール値を解決する
   * get/list は read にフォールバック、create/update/delete は write にフォールバック
   */
  private resolveOperationRule(
    rule: CollectionRule,
    operation: Operation,
  ): boolean | string | undefined {
    switch (operation) {
      case "get":
        return rule.get ?? rule.read;
      case "list":
        return rule.list ?? rule.read;
      case "read":
        return rule.read;
      case "create":
        return rule.create ?? rule.write;
      case "update":
        return rule.update ?? rule.write;
      case "delete":
        return rule.delete ?? rule.write;
      case "write":
        return rule.write;
    }
  }

  /**
   * ルール式を評価する
   *
   * サポートする式:
   * - "true" / "false"
   * - "auth != null" (認証済みかどうか)
   * - "auth.uid == documentId" (自分のドキュメントか)
   * - "auth.uid == resource.data.userId" (ドキュメントのuserIdが自分か)
   * - "request.data.keys().size() <= N" (フィールド数制限)
   */
  private evaluateExpression(expr: string, context: RuleContext): boolean {
    const trimmed = expr.trim();

    if (trimmed === "true") return true;
    if (trimmed === "false") return false;

    // auth != null
    if (trimmed === "auth != null") {
      return context.auth !== null;
    }

    // auth == null
    if (trimmed === "auth == null") {
      return context.auth === null;
    }

    // auth.uid == documentId
    if (trimmed === "auth.uid == documentId") {
      return context.auth?.uid === context.documentId;
    }

    // auth.uid == resource.data.<field>
    const resourceMatch = trimmed.match(/^auth\.uid\s*==\s*resource\.data\.(\w+)$/);
    if (resourceMatch) {
      const field = resourceMatch[1];
      return context.auth?.uid === context.existingData?.[field];
    }

    // request.data.keys().size() <= N
    const sizeMatch = trimmed.match(/^request\.data\.keys\(\)\.size\(\)\s*<=\s*(\d+)$/);
    if (sizeMatch) {
      const maxSize = Number(sizeMatch[1]);
      const keys = context.requestData ? Object.keys(context.requestData) : [];
      return keys.length <= maxSize;
    }

    // && (AND) 演算子
    if (trimmed.includes("&&")) {
      const parts = trimmed.split("&&");
      return parts.every((part) => this.evaluateExpression(part, context));
    }

    // || (OR) 演算子
    if (trimmed.includes("||")) {
      const parts = trimmed.split("||");
      return parts.some((part) => this.evaluateExpression(part, context));
    }

    // 未知の式はデフォルト拒否
    return false;
  }
}

/**
 * デフォルトのセキュリティルール（全アクセス許可 - 開発用）
 */
export function createOpenRules(): SecurityRules {
  return {
    rules: {
      "{collection}": {
        read: true,
        write: true,
      },
    },
  };
}

/**
 * 認証必須のデフォルトルール
 */
export function createAuthRequiredRules(): SecurityRules {
  return {
    rules: {
      "{collection}": {
        read: "auth != null",
        write: "auth != null",
      },
    },
  };
}
