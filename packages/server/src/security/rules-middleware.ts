import type {
  AggregateRequest,
  BatchOperation,
  BatchRequest,
  DocumentData,
  QueryRequest,
  TransactionCommitRequest,
  TransactionGetRequest,
} from "@local-firestore/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { DocumentService } from "../services/document.js";
import type { QueryService } from "../services/query.js";
import { isDocumentPath, parseDocumentPath } from "../utils/path.js";
import type { AuthProvider } from "./auth-provider.js";
import {
  type AuthContext,
  extractQueryParams,
  type ListQueryDocument,
  type Operation,
  type RuleEvaluationResult,
  type SecurityRulesEngine,
} from "./rules-engine.js";

/**
 * HTTPメソッドとパスからOperation種別を判定する
 */
function resolveOperation(method: string, path: string): Operation | null {
  switch (method) {
    case "GET":
      return isDocumentPath(path) ? "get" : "list";
    case "POST":
      return "create";
    case "PUT":
      return "create";
    case "PATCH":
      return "update";
    case "DELETE":
      return "delete";
    default:
      return null;
  }
}

/**
 * リクエストボディから書き込みデータを抽出する
 */
async function extractRequestData(
  method: string,
  req: { json: <T>() => Promise<T> },
): Promise<DocumentData | undefined> {
  if (method === "PUT" || method === "PATCH" || method === "POST") {
    try {
      const body = await req.json<{ data?: DocumentData }>();
      return body?.data;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** ドキュメントパスを collectionPath / documentId に分解する */
function splitPath(docPath: string): { collectionPath: string; documentId: string } {
  if (isDocumentPath(docPath)) {
    const parsed = parseDocumentPath(docPath);
    return { collectionPath: parsed.collectionPath, documentId: parsed.documentId };
  }
  return { collectionPath: docPath, documentId: "" };
}

/** permission-denied レスポンスを返す */
function denied(c: Context, result: RuleEvaluationResult) {
  return c.json(
    {
      code: "permission-denied",
      message: result.reason ?? "Permission denied by security rules",
    },
    403,
  );
}

/**
 * バッチ / トランザクションの書き込みオペレーション一覧をルール評価する。
 * 全て許可された場合は null、拒否された場合はその評価結果を返す。
 */
function evaluateWriteOperations(
  engine: SecurityRulesEngine,
  auth: AuthContext | null,
  operations: BatchOperation[],
  documentService: DocumentService | undefined,
  requestTime: Date,
): RuleEvaluationResult | null {
  for (const op of operations) {
    const { collectionPath, documentId } = splitPath(op.path);
    const existing = documentService?.getDocument(op.path);

    // set は既存ドキュメントの有無で create / update を切り替える（本家と同じ扱い）
    let operation: Operation;
    if (op.type === "set") {
      operation = existing ? "update" : "create";
    } else if (op.type === "update") {
      operation = "update";
    } else {
      operation = "delete";
    }

    const result = engine.evaluate(operation, {
      auth,
      path: op.path,
      documentId,
      collectionPath,
      requestData: op.data,
      existingData: existing?.data,
      requestTime,
    });
    if (!result.allowed) {
      return {
        ...result,
        reason: `${result.reason ?? "Permission denied by security rules"} (path: ${op.path})`,
      };
    }
  }
  return null;
}

/**
 * セキュリティルールミドルウェア
 *
 * 以下のエンドポイントに対してセキュリティルールを適用する:
 * - /docs/*            — ドキュメント CRUD（get / list / create / update / delete）
 * - /query, /aggregate — list オペレーションとして評価
 * - /batch             — 各オペレーションを create / update / delete として評価
 * - /transaction/get   — get オペレーションとして評価
 * - /transaction/commit — 各オペレーションを create / update / delete として評価
 *
 * /admin/*, /health, /metrics, /export, /import, /triggers,
 * /transaction/begin, /transaction/rollback は対象外。
 */
export function securityRulesMiddleware(
  engine: SecurityRulesEngine,
  authProvider: AuthProvider,
  documentService?: DocumentService,
  queryService?: QueryService,
): MiddlewareHandler {
  return async (c, next) => {
    const reqPath = c.req.path;
    const method = c.req.method;
    const requestTime = new Date();

    // クエリ / 集計: list オペレーションとして評価
    // ルールが resource / documentId を参照する場合は per-document 評価を行い、
    // 1件でも拒否があればクエリ全体を permission-denied にする（本家の
    // 「ルールはフィルタではない」セマンティクスの実用近似）
    if ((reqPath === "/query" || reqPath === "/aggregate") && method === "POST") {
      let body: QueryRequest | AggregateRequest;
      try {
        body = await c.req.json<QueryRequest | AggregateRequest>();
      } catch {
        return next();
      }
      const collectionPath = body.collectionPath;
      if (!collectionPath) {
        return next();
      }
      const collectionGroup = body.collectionGroup ?? false;
      const auth = await authProvider.extractAuth(c.req.header("Authorization"));
      const queryParams = extractQueryParams(body.constraints);

      let result: RuleEvaluationResult;
      if (queryService && engine.needsPerDocumentListEvaluation(collectionPath, collectionGroup)) {
        let docs: ListQueryDocument[];
        try {
          docs = queryService.executeQuery(collectionPath, body.constraints, collectionGroup);
        } catch {
          // クエリ自体が無効な場合はルートハンドラでエラーレスポンスを返す
          return next();
        }
        result = engine.evaluateListQuery(
          { auth, collectionPath, collectionGroup, requestTime, queryParams },
          docs,
        );
      } else {
        result = engine.evaluate("list", {
          auth,
          path: collectionPath,
          documentId: "",
          collectionPath,
          requestTime,
          queryParams,
        });
      }
      if (!result.allowed) {
        return denied(c, result);
      }
      return next();
    }

    // バッチ書き込み: 各オペレーションを個別に評価
    if (reqPath === "/batch" && method === "POST") {
      let body: BatchRequest;
      try {
        body = await c.req.json<BatchRequest>();
      } catch {
        return next();
      }
      if (!Array.isArray(body.operations)) {
        return next();
      }
      const auth = await authProvider.extractAuth(c.req.header("Authorization"));
      const deniedResult = evaluateWriteOperations(
        engine,
        auth,
        body.operations,
        documentService,
        requestTime,
      );
      if (deniedResult) {
        return denied(c, deniedResult);
      }
      return next();
    }

    // トランザクション内の読み取り: get オペレーションとして評価
    if (reqPath === "/transaction/get" && method === "POST") {
      let body: TransactionGetRequest;
      try {
        body = await c.req.json<TransactionGetRequest>();
      } catch {
        return next();
      }
      if (!body.path) {
        return next();
      }
      const auth = await authProvider.extractAuth(c.req.header("Authorization"));
      const { collectionPath, documentId } = splitPath(body.path);
      const result = engine.evaluate("get", {
        auth,
        path: body.path,
        documentId,
        collectionPath,
        existingData: documentService?.getDocument(body.path)?.data,
        requestTime,
      });
      if (!result.allowed) {
        return denied(c, result);
      }
      return next();
    }

    // トランザクションコミット: 各オペレーションを個別に評価
    if (reqPath === "/transaction/commit" && method === "POST") {
      let body: TransactionCommitRequest;
      try {
        body = await c.req.json<TransactionCommitRequest>();
      } catch {
        return next();
      }
      if (!Array.isArray(body.operations)) {
        return next();
      }
      const auth = await authProvider.extractAuth(c.req.header("Authorization"));
      const deniedResult = evaluateWriteOperations(
        engine,
        auth,
        body.operations,
        documentService,
        requestTime,
      );
      if (deniedResult) {
        return denied(c, deniedResult);
      }
      return next();
    }

    // ドキュメントAPI以外はスキップ
    if (!reqPath.startsWith("/docs")) {
      return next();
    }

    const docPath = reqPath.replace("/docs/", "").replace("/docs", "");
    if (!docPath) {
      return next();
    }

    const operation = resolveOperation(method, docPath);
    if (!operation) {
      return next();
    }

    const auth = await authProvider.extractAuth(c.req.header("Authorization"));

    // パス解析
    const { collectionPath, documentId } = splitPath(docPath);

    // リクエストデータの抽出（書き込み操作時）
    const requestData = await extractRequestData(method, c.req);

    // 既存ドキュメントデータの取得（update/delete時）
    let existingData: DocumentData | undefined;
    if (
      documentService &&
      (operation === "update" || operation === "delete") &&
      isDocumentPath(docPath)
    ) {
      const existing = documentService.getDocument(docPath);
      existingData = existing?.data;
    }

    const result = engine.evaluate(operation, {
      auth,
      path: docPath,
      documentId,
      collectionPath,
      requestData,
      existingData,
      requestTime,
    });

    if (!result.allowed) {
      return denied(c, result);
    }

    return next();
  };
}
