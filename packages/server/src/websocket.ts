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
import type { SecurityRulesEngine } from "./security/rules-engine.js";
import { DEFAULT_DATABASE_ID } from "./services/database-manager.js";
import type { ListenerManager } from "./services/listener-manager.js";
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
 * サブスクリプションに対するセキュリティルール評価。
 * 許可された場合は null、拒否された場合は理由文字列を返す。
 */
async function evaluateSubscription(
  deps: WebSocketDeps,
  target: DatabaseListenerDeps,
  msg: SubscribeDocMessage | SubscribeQueryMessage,
): Promise<string | null> {
  if (!deps.securityRules || !deps.authProvider) return null;

  const auth = await deps.authProvider.extractAuth(toAuthHeader(msg.authToken));

  if (msg.type === "subscribe_doc") {
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

  const result = deps.securityRules.evaluate("list", {
    auth,
    path: msg.collectionPath,
    documentId: "",
    collectionPath: msg.collectionPath,
    requestTime: new Date(),
  });
  return result.allowed ? null : (result.reason ?? "Permission denied by security rules");
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
          const deniedReason = await evaluateSubscription(deps, target, msg);
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
          const deniedReason = await evaluateSubscription(deps, target, msg);
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
