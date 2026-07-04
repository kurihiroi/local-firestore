import type { Server as HttpServer } from "node:http";
import type {
  ClientMessage,
  DocumentMetadata,
  SnapshotErrorMessage,
} from "@local-firestore/shared";
import { WebSocketServer } from "ws";
import { DEFAULT_DATABASE_ID } from "./services/database-manager.js";
import type { ListenerManager } from "./services/listener-manager.js";

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
}

/**
 * HTTPサーバーにWebSocketサーバーをアタッチする
 */
export function attachWebSocket(server: HttpServer, deps: WebSocketDeps): WebSocketServer {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    // この接続がサブスクリプションを登録した ListenerManager（切断時のクリーンアップ用）
    const usedManagers = new Set<ListenerManager>([deps.listenerManager]);

    const sendError = (subscriptionId: string, message: string) => {
      const errorMsg: SnapshotErrorMessage = {
        type: "error",
        subscriptionId,
        code: "invalid-argument",
        message,
      };
      ws.send(JSON.stringify(errorMsg));
    };

    /** メッセージの databaseId に対応する依存を解決する（デフォルトは deps 自身） */
    const resolveDeps = (databaseId?: string): DatabaseListenerDeps | undefined => {
      if (!databaseId || databaseId === DEFAULT_DATABASE_ID) return deps;
      return deps.resolveDatabase?.(databaseId);
    };

    ws.on("message", (raw) => {
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
    });

    ws.on("close", () => {
      for (const manager of usedManagers) {
        manager.removeConnection(ws);
      }
    });
  });

  return wss;
}
