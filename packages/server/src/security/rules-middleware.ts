import type { DocumentData } from "@local-firestore/shared";
import type { MiddlewareHandler } from "hono";
import type { DocumentService } from "../services/document.js";
import { isDocumentPath, parseDocumentPath } from "../utils/path.js";
import type { AuthProvider } from "./auth-provider.js";
import type { Operation, SecurityRulesEngine } from "./rules-engine.js";

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

/**
 * セキュリティルールミドルウェア
 *
 * /docs/* パスへのリクエストに対してセキュリティルールを適用する。
 * /admin/*, /health, /metrics, /export, /import, /query, /aggregate, /batch, /transaction
 * は対象外。
 */
export function securityRulesMiddleware(
  engine: SecurityRulesEngine,
  authProvider: AuthProvider,
  documentService?: DocumentService,
): MiddlewareHandler {
  return async (c, next) => {
    const reqPath = c.req.path;

    // ドキュメントAPI以外はスキップ
    if (!reqPath.startsWith("/docs")) {
      return next();
    }

    const docPath = reqPath.replace("/docs/", "").replace("/docs", "");
    if (!docPath) {
      return next();
    }

    const operation = resolveOperation(c.req.method, docPath);
    if (!operation) {
      return next();
    }

    const auth = await authProvider.extractAuth(c.req.header("Authorization"));

    // パス解析
    let collectionPath: string;
    let documentId: string;
    if (isDocumentPath(docPath)) {
      const parsed = parseDocumentPath(docPath);
      collectionPath = parsed.collectionPath;
      documentId = parsed.documentId;
    } else {
      collectionPath = docPath;
      documentId = "";
    }

    // リクエストデータの抽出（書き込み操作時）
    const requestData = await extractRequestData(c.req.method, c.req);

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
      requestTime: new Date(),
    });

    if (!result.allowed) {
      return c.json(
        {
          code: "permission-denied",
          message: result.reason ?? "Permission denied by security rules",
        },
        403,
      );
    }

    return next();
  };
}
