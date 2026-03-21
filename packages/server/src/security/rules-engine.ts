import type { DocumentData } from "@local-firestore/shared";
import {
  BuiltinFunctionContext,
  type DocumentResolver,
} from "./rules-evaluator/builtin-functions.js";
import type { EvaluationContext, QueryParams } from "./rules-evaluator/context.js";
import { RulesEvaluator } from "./rules-evaluator/evaluator.js";

/** 操作の種類 */
export type Operation = "read" | "get" | "list" | "write" | "create" | "update" | "delete";

/** セキュリティルール定義 */
export interface SecurityRules {
  rules: CollectionRules;
  /** グローバルカスタム関数定義（式文字列） */
  functions?: string;
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
  /** カスタム関数定義（式の前に付与される） */
  functions?: string;
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
  /** リクエスト時刻 */
  requestTime?: Date;
  /** クエリパラメータ */
  queryParams?: QueryParams;
}

/** 認証コンテキスト */
export interface AuthContext {
  uid: string;
  token?: Record<string, unknown>;
  [key: string]: unknown;
}

/** ルール評価結果 */
export interface RuleEvaluationResult {
  allowed: boolean;
  rule?: string;
  reason?: string;
}

/** ワイルドカードパターン: {variableName} or {variableName=**} */
const WILDCARD_PATTERN = /^\{(\w+)(=\*\*)?\}$/;

/**
 * セキュリティルールエンジン
 *
 * Firebaseセキュリティルールの完全実装。
 * ASTベースのパーサー・評価器でルール式を評価する。
 */
export class SecurityRulesEngine {
  private rules: SecurityRules;
  private evaluator: RulesEvaluator;

  constructor(rules: SecurityRules, resolver?: DocumentResolver) {
    this.rules = rules;
    const builtins = new BuiltinFunctionContext(resolver ?? null);
    this.evaluator = new RulesEvaluator(builtins);
  }

  /**
   * 指定された操作が許可されるか評価する
   */
  evaluate(operation: Operation, context: RuleContext): RuleEvaluationResult {
    const segments = context.collectionPath.split("/");
    let currentRules = this.rules.rules;
    let matchedRule: CollectionRule | undefined;
    const wildcardBindings: Record<string, string> = {};

    // コレクションパスに沿ってルールを探索
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const match = this.findMatchingRule(currentRules, segment, wildcardBindings);

      if (!match) {
        return {
          allowed: false,
          reason: `No rule found for collection: ${context.collectionPath}`,
        };
      }

      matchedRule = match;

      // 次のサブコレクション層へ進む
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

    // 文字列の場合はAST評価器で評価
    try {
      // カスタム関数定義を式の前に付与
      const functionsPrefix = this.buildFunctionsPrefix(matchedRule);
      const fullExpr = functionsPrefix + ruleValue;

      const evalContext: EvaluationContext = {
        auth: context.auth,
        path: context.path,
        documentId: context.documentId,
        collectionPath: context.collectionPath,
        operation,
        requestData: context.requestData,
        existingData: context.existingData,
        requestTime: context.requestTime ?? new Date(),
        queryParams: context.queryParams,
        wildcardBindings,
      };

      const allowed = this.evaluator.evaluateExpression(fullExpr, evalContext);
      return { allowed, rule: ruleValue };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { allowed: false, reason: `Rule evaluation error: ${message}`, rule: ruleValue };
    }
  }

  /**
   * コレクションルールからマッチするルールを探す
   * 完全一致 → ワイルドカード → 再帰ワイルドカード の優先順
   */
  private findMatchingRule(
    rules: CollectionRules,
    segment: string,
    wildcardBindings: Record<string, string>,
  ): CollectionRule | undefined {
    // 1. 完全一致
    if (rules[segment]) {
      return rules[segment];
    }

    // 2. ワイルドカードパターン（{variableName}）
    for (const [pattern, rule] of Object.entries(rules)) {
      const match = WILDCARD_PATTERN.exec(pattern);
      if (match) {
        const varName = match[1];
        const isRecursive = !!match[2];
        if (!isRecursive) {
          wildcardBindings[varName] = segment;
          return rule;
        }
      }
    }

    // 3. 再帰ワイルドカード（{variableName=**}）
    for (const [pattern, rule] of Object.entries(rules)) {
      const match = WILDCARD_PATTERN.exec(pattern);
      if (match?.[2]) {
        const varName = match[1];
        wildcardBindings[varName] = segment;
        return rule;
      }
    }

    return undefined;
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
   * カスタム関数定義を式の前に付与するプレフィックスを構築
   */
  private buildFunctionsPrefix(rule: CollectionRule): string {
    let prefix = "";
    if (this.rules.functions) {
      prefix += `${this.rules.functions} `;
    }
    if (rule.functions) {
      prefix += `${rule.functions} `;
    }
    return prefix;
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
