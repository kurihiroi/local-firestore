import type { DocumentData } from "@local-firestore/shared";
import type { AuthContext, Operation } from "../rules-engine.js";
import { documentDataToRulesMap } from "./special-types.js";
import {
  mkInt,
  mkMap,
  mkNull,
  mkPath,
  mkString,
  mkTimestamp,
  type RulesMap,
  type RulesValue,
  toRulesValue,
} from "./types.js";

/**
 * ルール評価に必要な拡張コンテキスト
 */
export interface EvaluationContext {
  auth: AuthContext | null;
  path: string;
  documentId: string;
  collectionPath: string;
  operation: Operation;
  requestData?: DocumentData;
  existingData?: DocumentData;
  requestTime: Date;
  queryParams?: QueryParams;
  /** ワイルドカードにバインドされた変数 */
  wildcardBindings: Record<string, string>;
}

export interface QueryParams {
  limit?: number;
  offset?: number;
  orderBy?: string;
}

/**
 * 評価コンテキストからグローバル変数マップを構築する
 */
export function buildGlobalScope(ctx: EvaluationContext): Map<string, RulesValue> {
  const scope = new Map<string, RulesValue>();

  // request オブジェクト
  scope.set("request", buildRequestObject(ctx));

  // resource オブジェクト
  scope.set("resource", buildResourceObject(ctx));

  // ワイルドカード変数のバインディング
  for (const [name, value] of Object.entries(ctx.wildcardBindings)) {
    scope.set(name, mkString(value));
  }

  // documentId (後方互換)
  scope.set("documentId", mkString(ctx.documentId));

  // auth (後方互換: トップレベルでもアクセス可能)
  if (ctx.auth) {
    scope.set("auth", buildAuthObject(ctx.auth));
  } else {
    scope.set("auth", mkNull());
  }

  return scope;
}

function buildRequestObject(ctx: EvaluationContext): RulesMap {
  const map = new Map<string, RulesValue>();

  // request.auth
  if (ctx.auth) {
    map.set("auth", buildAuthObject(ctx.auth));
  } else {
    map.set("auth", mkNull());
  }

  // request.resource
  if (ctx.requestData) {
    const dataMap = documentDataToRulesMap(ctx.requestData);
    const resourceMap = new Map<string, RulesValue>();
    resourceMap.set("data", dataMap);
    resourceMap.set("id", mkString(ctx.documentId));
    resourceMap.set("__name__", mkString(ctx.path));
    map.set("resource", mkMap(resourceMap));
    // request.data は request.resource.data のショートカット（後方互換）
    map.set("data", dataMap);
  } else {
    map.set("resource", mkNull());
  }

  // request.time
  map.set("time", mkTimestamp(ctx.requestTime));

  // request.path
  map.set("path", mkPath(`/databases/(default)/documents/${ctx.path}`));

  // request.method
  map.set("method", mkString(ctx.operation));

  // request.query
  // list 評価時は limit / offset / orderBy を常に束縛する（未指定は本家同様 null / 0）
  if (ctx.queryParams) {
    const queryMap = new Map<string, RulesValue>();
    queryMap.set(
      "limit",
      ctx.queryParams.limit !== undefined ? mkInt(ctx.queryParams.limit) : mkNull(),
    );
    queryMap.set("offset", mkInt(ctx.queryParams.offset ?? 0));
    queryMap.set(
      "orderBy",
      ctx.queryParams.orderBy !== undefined ? mkString(ctx.queryParams.orderBy) : mkNull(),
    );
    map.set("query", mkMap(queryMap));
  }

  return mkMap(map);
}

function buildResourceObject(ctx: EvaluationContext): RulesValue {
  if (!ctx.existingData) {
    return mkNull();
  }

  const map = new Map<string, RulesValue>();
  map.set("data", documentDataToRulesMap(ctx.existingData));
  map.set("id", mkString(ctx.documentId));
  map.set("__name__", mkString(`/databases/(default)/documents/${ctx.path}`));
  return mkMap(map);
}

function buildAuthObject(auth: AuthContext): RulesMap {
  const map = new Map<string, RulesValue>();
  map.set("uid", mkString(auth.uid));

  // auth.token（カスタムクレーム含む）
  if (auth.token && typeof auth.token === "object") {
    map.set("token", toRulesValue(auth.token));
  } else {
    // uid以外のプロパティをtokenとして扱う
    const tokenMap = new Map<string, RulesValue>();
    for (const [key, value] of Object.entries(auth)) {
      if (key !== "uid") {
        tokenMap.set(key, toRulesValue(value));
      }
    }
    if (tokenMap.size > 0) {
      map.set("token", mkMap(tokenMap));
    }
  }

  return mkMap(map);
}
