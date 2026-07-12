import type { DocumentData, SerializedQueryConstraint } from "@local-firestore/shared";
import { parseDocumentPath } from "../utils/path.js";
import {
  BuiltinFunctionContext,
  type DocumentResolver,
  type PendingWrites,
} from "./rules-evaluator/builtin-functions.js";
import type { EvaluationContext, QueryParams } from "./rules-evaluator/context.js";
import { RulesEvaluator } from "./rules-evaluator/evaluator.js";
import type { Expression, RuleExpression } from "./rules-parser/ast.js";
import { Parser } from "./rules-parser/parser.js";

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
  /** 評価中の書き込みの「書き込み後の状態」（getAfter / existsAfter 用） */
  pendingWrites?: PendingWrites;
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

/** list クエリの per-document 評価に渡すドキュメント */
export interface ListQueryDocument {
  path: string;
  data: DocumentData;
}

/** list クエリ評価のオプション */
export interface ListQueryContext {
  auth: AuthContext | null;
  /** クエリ対象のコレクションパス（コレクショングループの場合はグループID） */
  collectionPath: string;
  /** コレクショングループクエリかどうか */
  collectionGroup?: boolean;
  /** リクエスト時刻 */
  requestTime?: Date;
  /** クエリパラメータ（request.query に束縛される） */
  queryParams?: QueryParams;
}

/** ワイルドカードパターン: {variableName} or {variableName=**} */
const WILDCARD_PATTERN = /^\{(\w+)(=\*\*)?\}$/;

/** ルールマッチの結果 */
interface RuleMatch {
  rule: CollectionRule;
  bindings: Record<string, string>;
}

/**
 * セキュリティルールエンジン
 *
 * Firebaseセキュリティルールの完全実装。
 * ASTベースのパーサー・評価器でルール式を評価する。
 */
export class SecurityRulesEngine {
  private rules: SecurityRules;
  private evaluator: RulesEvaluator;
  /** list ルールの per-document 評価要否のキャッシュ（キー: 式文字列） */
  private perDocumentCache = new Map<string, boolean>();

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
    const match = this.matchRules(this.rules.rules, segments, 0, {}, operation);

    if (!match) {
      return {
        allowed: false,
        reason: `No rule found for collection: ${context.collectionPath} (operation: ${operation})`,
      };
    }

    const matchedRule = match.rule;
    const wildcardBindings = match.bindings;

    // 操作に対応するルールを取得（matchRules が操作定義済みルールのみ返すため必ず存在する）
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
        pendingWrites: context.pendingWrites,
      };

      const allowed = this.evaluator.evaluateExpression(fullExpr, evalContext);
      return { allowed, rule: ruleValue };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { allowed: false, reason: `Rule evaluation error: ${message}`, rule: ruleValue };
    }
  }

  /**
   * list クエリを per-document で評価する。
   *
   * 本家の「ルールはフィルタではない」セマンティクスの実用近似として、
   * 返却対象の各ドキュメントについて resource を実データで束縛して list ルールを
   * 評価し、1件でも拒否があればクエリ全体を permission-denied にする。
   *
   * - ルールが resource / documentId を参照しない場合（および boolean ルール）は
   *   コレクションパスで1回だけ評価する
   * - 空結果のクエリはコレクションパスで1回評価する（resource == null）
   * - コレクショングループクエリでは各ドキュメントの実パスでルールをマッチさせる
   */
  evaluateListQuery(
    context: ListQueryContext,
    docs: ReadonlyArray<ListQueryDocument>,
  ): RuleEvaluationResult {
    const requestTime = context.requestTime ?? new Date();
    const collectionGroup = context.collectionGroup ?? false;

    const collectionLevelResult = () =>
      this.evaluate("list", {
        auth: context.auth,
        path: context.collectionPath,
        documentId: "",
        collectionPath: context.collectionPath,
        requestTime,
        queryParams: context.queryParams,
      });

    if (!this.needsPerDocumentListEvaluation(context.collectionPath, collectionGroup)) {
      return collectionLevelResult();
    }

    if (docs.length === 0) {
      return collectionLevelResult();
    }

    for (const doc of docs) {
      let collectionPath: string;
      let documentId: string;
      try {
        const parsed = parseDocumentPath(doc.path);
        collectionPath = parsed.collectionPath;
        documentId = parsed.documentId;
      } catch {
        return { allowed: false, reason: `Invalid document path: ${doc.path}` };
      }

      const result = this.evaluate("list", {
        auth: context.auth,
        path: doc.path,
        documentId,
        collectionPath,
        existingData: doc.data,
        requestTime,
        queryParams: context.queryParams,
      });
      if (!result.allowed) {
        return {
          ...result,
          reason: `${result.reason ?? "Permission denied by security rules"} (path: ${doc.path})`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * list ルールの評価に per-document のドキュメントデータが必要かを静的解析で判定する。
   *
   * - コレクショングループクエリは実ドキュメントパスでのマッチが必要なため常に true
   * - ルール式が resource / documentId を参照する場合は true
   * - boolean ルール・ルール未定義の場合は false（1回評価で十分）
   */
  needsPerDocumentListEvaluation(collectionPath: string, collectionGroup = false): boolean {
    if (collectionGroup) return true;

    const segments = collectionPath.split("/");
    const match = this.matchRules(this.rules.rules, segments, 0, {}, "list");
    if (!match) return false;

    const ruleValue = this.resolveOperationRule(match.rule, "list");
    if (ruleValue === undefined || typeof ruleValue === "boolean") return false;

    const fullExpr = this.buildFunctionsPrefix(match.rule) + ruleValue;
    const cached = this.perDocumentCache.get(fullExpr);
    if (cached !== undefined) return cached;

    let needs: boolean;
    try {
      const parsed = Parser.parseRule(fullExpr);
      needs = ruleReferencesDocumentScope(parsed);
    } catch {
      // パース不能な式は評価時にエラー拒否となるため、per-document 側に倒す
      needs = true;
    }
    this.perDocumentCache.set(fullExpr, needs);
    return needs;
  }

  /**
   * コレクションパスのセグメント列をルールツリーとマッチさせる（バックトラッキング付き）。
   *
   * 優先順位: 完全一致 → 単一ワイルドカード（{name}） → 再帰ワイルドカード（{name=**}）。
   * 再帰ワイルドカードは本家の rules_version = '2' と同様に複数セグメント
   * （0個以上、貪欲）を消費できる。
   * リーフでは対象操作が定義されたルールのみマッチ成立とし、未定義なら
   * バックトラックして他の候補を探す（本家の「いずれかの match が許可すれば許可」の近似）。
   */
  private matchRules(
    rules: CollectionRules,
    segments: string[],
    start: number,
    bindings: Record<string, string>,
    operation: Operation,
  ): RuleMatch | undefined {
    if (start >= segments.length) return undefined;

    const segment = segments[start];

    const tryDescend = (
      rule: CollectionRule,
      nextStart: number,
      newBindings: Record<string, string>,
    ): RuleMatch | undefined => {
      if (nextStart >= segments.length) {
        if (this.resolveOperationRule(rule, operation) === undefined) return undefined;
        return { rule, bindings: newBindings };
      }
      if (!rule.subcollections) return undefined;
      return this.matchRules(rule.subcollections, segments, nextStart, newBindings, operation);
    };

    // 1. 完全一致
    if (rules[segment]) {
      const result = tryDescend(rules[segment], start + 1, bindings);
      if (result) return result;
    }

    // 2. 単一ワイルドカード（{variableName}）
    for (const [pattern, rule] of Object.entries(rules)) {
      const match = WILDCARD_PATTERN.exec(pattern);
      if (match && !match[2]) {
        const result = tryDescend(rule, start + 1, { ...bindings, [match[1]]: segment });
        if (result) return result;
      }
    }

    // 3. 再帰ワイルドカード（{variableName=**}）: 貪欲に複数セグメントを消費し、
    //    マッチしなければ消費数を減らしてバックトラックする（0個まで）
    for (const [pattern, rule] of Object.entries(rules)) {
      const match = WILDCARD_PATTERN.exec(pattern);
      if (match?.[2]) {
        const varName = match[1];
        const remaining = segments.length - start;
        for (let consume = remaining; consume >= 0; consume--) {
          const bound = segments.slice(start, start + consume).join("/");
          const result = tryDescend(rule, start + consume, { ...bindings, [varName]: bound });
          if (result) return result;
        }
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
 * クエリ制約から request.query に束縛するパラメータを抽出する。
 * limit が重複指定された場合は最後の指定が有効（クエリ実行と同じセマンティクス）。
 */
export function extractQueryParams(
  constraints: ReadonlyArray<SerializedQueryConstraint> | undefined,
): QueryParams {
  const params: QueryParams = {};
  const orderByParts: string[] = [];
  for (const c of constraints ?? []) {
    if (c.type === "limit" || c.type === "limitToLast") {
      params.limit = c.limit;
    } else if (c.type === "orderBy") {
      orderByParts.push(`${c.fieldPath} ${c.direction === "desc" ? "DESC" : "ASC"}`);
    }
  }
  if (orderByParts.length > 0) {
    params.orderBy = orderByParts.join(", ");
  }
  return params;
}

/** ルール式が resource / documentId（ドキュメント単位の値）を参照するか */
function ruleReferencesDocumentScope(parsed: RuleExpression): boolean {
  const targets = new Set(["resource", "documentId"]);

  const walk = (node: Expression): boolean => {
    switch (node.type) {
      case "Identifier":
        return targets.has(node.name);
      case "MemberExpression":
        return walk(node.object);
      case "IndexExpression":
        return walk(node.object) || walk(node.index);
      case "CallExpression":
        return walk(node.callee) || node.arguments.some(walk);
      case "BinaryExpression":
        return walk(node.left) || walk(node.right);
      case "UnaryExpression":
        return walk(node.operand);
      case "ConditionalExpression":
        return walk(node.test) || walk(node.consequent) || walk(node.alternate);
      case "IsExpression":
        return walk(node.value);
      case "ListExpression":
        return node.elements.some(walk);
      case "MapExpression":
        return node.entries.some((e) => walk(e.key) || walk(e.value));
      case "StringLiteral":
        // パス補間 $(resource...) / $(documentId) を含む可能性
        return /\$\(\s*(resource|documentId)\b/.test(node.value);
      default:
        return false;
    }
  };

  if (walk(parsed.expression)) return true;
  for (const fn of parsed.functions) {
    if (walk(fn.body)) return true;
    for (const binding of fn.bindings) {
      if (walk(binding.value)) return true;
    }
  }
  return false;
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
