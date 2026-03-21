import type { MiddlewareHandler } from "hono";
import { isDocumentPath, parseDocumentPath } from "../utils/path.js";
import type { AuthContext, Operation, SecurityRulesEngine } from "./rules-engine.js";

/**
 * リクエストからAuthContextを抽出する
 * Authorization: Bearer <uid> 形式のヘッダーを解析する（簡易実装）
 *
 * 拡張形式: Bearer <uid>:<json_claims> でカスタムクレームも渡せる
 */
function extractAuth(authHeader: string | undefined): AuthContext | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match) return null;

  const payload = match[1];

  // uid:json_claims 形式のサポート
  const colonIndex = payload.indexOf(":");
  if (colonIndex > 0) {
    const uid = payload.slice(0, colonIndex);
    const claimsStr = payload.slice(colonIndex + 1);
    try {
      const claims = JSON.parse(claimsStr) as Record<string, unknown>;
      return { uid, token: claims };
    } catch {
      // JSON パース失敗時は uid のみ
      return { uid };
    }
  }

  return { uid: payload };
}

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
 * セキュリティルールミドルウェア
 *
 * /docs/* パスへのリクエストに対してセキュリティルールを適用する。
 * /admin/*, /health, /metrics, /export, /import, /query, /aggregate, /batch, /transaction
 * は対象外。
 */
export function securityRulesMiddleware(engine: SecurityRulesEngine): MiddlewareHandler {
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

    const auth = extractAuth(c.req.header("Authorization"));

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

    const result = engine.evaluate(operation, {
      auth,
      path: docPath,
      documentId,
      collectionPath,
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
