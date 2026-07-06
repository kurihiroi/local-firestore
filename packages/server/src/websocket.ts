import type { Server as HttpServer } from "node:http";
import type {
  ClientMessage,
  DocumentMetadata,
  SnapshotErrorMessage,
  SubscribeDocMessage,
  SubscribeQueryMessage,
} from "@local-firestore/shared";
import { WebSocketServer } from "ws";
import type { AuthProvider } from "./security/auth-provider.js";
import { extractQueryParams, type SecurityRulesEngine } from "./security/rules-engine.js";
import { DEFAULT_DATABASE_ID } from "./services/database-manager.js";
import type { ListenerManager, QueryRulesGuard } from "./services/listener-manager.js";
import { isDocumentPath, parseDocumentPath } from "./utils/path.js";

/** データベースごとのリスナー処理に必要な依存 */
export interface DatabaseListenerDeps {
  listenerManager: ListenerManager;
  getDocument: (path: string) => DocumentMetadata | undefined;
}

export interface WebSocketDeps extends DatabaseListenerDeps {
  /**
   * マルチデータベース対応: databaseId に対応する依存を解決する。
   * 未指定の場合、デフォルト以外の databaseId を含むメッセージはエラーになる。
   */
  resolveDatabase?: (databaseId: string) => DatabaseListenerDeps | undefined;
  /**
   * セキュリティルールエンジン。authProvider とあわせて指定すると、
   * subscribe_doc は get、subscribe_query は list オペレーションとして
   * ルール評価され、拒否時はエラーメッセージが返る。
   */
  securityRules?: SecurityRulesEngine;
  /** 認証プロバイダー（subscribe メッセージの authToken を解決する） */
  authProvider?: AuthProvider;
}

/** subscribe メッセージの authToken を Authorization ヘッダー形式に正規化する */
function toAuthHeader(authToken: string | undefined): string | undefined {
  if (!authToken) return undefined;
  return authToken.startsWith("Bearer ") ? authToken : `Bearer ${authToken}`;
}

/**
 * ドキュメントサブスクリプションに対するセキュリティルール評価。
 * 許可された場合は null、拒否された場合は理由文字列を返す。
 */
async function evaluateDocSubscription(
  deps: WebSocketDeps,
  target: DatabaseListenerDeps,
  msg: SubscribeDocMessage,
): Promise<string | null> {
  if (!deps.securityRules || !deps.authProvider) return null;

  const auth = await deps.authProvider.extractAuth(toAuthHeader(msg.authToken));

  let collectionPath: string;
  let documentId: string;
  if (isDocumentPath(msg.path)) {
    const parsed = parseDocumentPath(msg.path);
    collectionPath = parsed.collectionPath;
    documentId = parsed.documentId;
  } else {
    collectionPath = msg.path;
    documentId = "";
  }
  const result = deps.securityRules.evaluate("get", {
    auth,
    path: msg.path,
    documentId,
    collectionPath,
    existingData: target.getDocument(msg.path)?.data,
    requestTime: new Date(),
  });
  return result.allowed ? null : (result.reason ?? "Permission denied by security rules");
}

/**
 * クエリサブスクリプションに対するセキュリティルール評価の準備。
 *
 * - ルールが resource / documentId を参照しない場合はこの場で1回評価し、
 *   拒否なら理由文字列を返す（ガード不要）
 * - per-document 評価が必要な場合は、スナップショットのドキュメント群を評価する
 *   ガード関数を返す。初回スナップショットと以降の追加・変更ドキュメントに対して
 *   ListenerManager から呼び出され、拒否に転じた場合は購読が終了する
 */
async function prepareQuerySubscription(
  deps: WebSocketDeps,
  msg: SubscribeQueryMessage,
): Promise<{ deniedReason: string | null; guard?: QueryRulesGuard }> {
  if (!deps.securityRules || !deps.authProvider) return { deniedReason: null };

  const engine = deps.securityRules;
  const auth = await deps.authProvider.extractAuth(toAuthHeader(msg.authToken));
  const collectionPath = msg.collectionPath;
  const collectionGroup = msg.collectionGroup ?? false;
  const queryParams = extractQueryParams(msg.constraints);

  if (engine.needsPerDocumentListEvaluation(collectionPath, collectionGroup)) {
    const guard: QueryRulesGuard = (docs) => {
      const result = engine.evaluateListQuery(
        { auth, collectionPath, collectionGroup, queryParams, requestTime: new Date() },
        docs,
      );
      return result.allowed ? null : (result.reason ?? "Permission denied by security rules");
    };
    return { deniedReason: null, guard };
  }

  const result = engine.evaluate("list", {
    auth,
    path: collectionPath,
    documentId: "",
    collectionPath,
    requestTime: new Date(),
    queryParams,
  });
  return {
    deniedReason: result.allowed ? null : (result.reason ?? "Permission denied by security rules"),
  };
}

/**
 * HTTPサーバーにWebSocketサーバーをアタッチする
 */
export function attachWebSocket(server: HttpServer, deps: WebSocketDeps): WebSocketServer {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    // この接続がサブスクリプションを登録した ListenerManager（切断時のクリーンアップ用）
    const usedManagers = new Set<ListenerManager>([deps.listenerManager]);

    const sendError = (
      subscriptionId: string,
      message: string,
      code: SnapshotErrorMessage["code"] = "invalid-argument",
    ) => {
      const errorMsg: SnapshotErrorMessage = {
        type: "error",
        subscriptionId,
        code,
        message,
      };
      ws.send(JSON.stringify(errorMsg));
    };

    /** メッセージの databaseId に対応する依存を解決する（デフォルトは deps 自身） */
    const resolveDeps = (databaseId?: string): DatabaseListenerDeps | undefined => {
      if (!databaseId || databaseId === DEFAULT_DATABASE_ID) return deps;
      return deps.resolveDatabase?.(databaseId);
    };

    const handleMessage = async (raw: unknown): Promise<void> => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        sendError("", "Invalid JSON");
        return;
      }

      switch (msg.type) {
        case "subscribe_doc": {
          const target = resolveDeps(msg.databaseId);
          if (!target) {
            sendError(msg.subscriptionId, `Unknown database: "${msg.databaseId}"`);
            return;
          }
          const deniedReason = await evaluateDocSubscription(deps, target, msg);
          if (deniedReason !== null) {
            sendError(msg.subscriptionId, deniedReason, "permission-denied");
            return;
          }
          usedManagers.add(target.listenerManager);
          target.listenerManager.subscribeDoc(ws, msg.subscriptionId, msg.path, target.getDocument);
          break;
        }
        case "subscribe_query": {
          const target = resolveDeps(msg.databaseId);
          if (!target) {
            sendError(msg.subscriptionId, `Unknown database: "${msg.databaseId}"`);
            return;
          }
          const { deniedReason, guard } = await prepareQuerySubscription(deps, msg);
          if (deniedReason !== null) {
            sendError(msg.subscriptionId, deniedReason, "permission-denied");
            return;
          }
          usedManagers.add(target.listenerManager);
          target.listenerManager.subscribeQuery(
            ws,
            msg.subscriptionId,
            msg.collectionPath,
            msg.collectionGroup ?? false,
            msg.constraints,
            guard,
          );
          break;
        }
        case "unsubscribe":
          for (const manager of usedManagers) {
            manager.unsubscribe(msg.subscriptionId);
          }
          break;
      }
    };

    ws.on("message", (raw) => {
      handleMessage(raw).catch((err) => {
        console.error("WebSocket message handling error:", err);
      });
    });

    ws.on("close", () => {
      for (const manager of usedManagers) {
        manager.removeConnection(ws);
      }
    });
  });

  return wss;
}
