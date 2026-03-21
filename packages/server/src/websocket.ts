import type { Server as HttpServer } from "node:http";
import type {
  ClientMessage,
  DocumentMetadata,
  SnapshotErrorMessage,
} from "@local-firestore/shared";
import { WebSocketServer } from "ws";
import type { ListenerManager } from "./services/listener-manager.js";

export interface WebSocketDeps {
  listenerManager: ListenerManager;
  getDocument: (path: string) => DocumentMetadata | undefined;
}

/**
 * HTTPサーバーにWebSocketサーバーをアタッチする
 */
export function attachWebSocket(server: HttpServer, deps: WebSocketDeps): WebSocketServer {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        const errorMsg: SnapshotErrorMessage = {
          type: "error",
          subscriptionId: "",
          code: "invalid-argument",
          message: "Invalid JSON",
        };
        ws.send(JSON.stringify(errorMsg));
        return;
      }

      switch (msg.type) {
        case "subscribe_doc":
          deps.listenerManager.subscribeDoc(ws, msg.subscriptionId, msg.path, deps.getDocument);
          break;
        case "subscribe_query":
          deps.listenerManager.subscribeQuery(
            ws,
            msg.subscriptionId,
            msg.collectionPath,
            msg.collectionGroup ?? false,
            msg.constraints,
          );
          break;
        case "unsubscribe":
          deps.listenerManager.unsubscribe(msg.subscriptionId);
          break;
      }
    });

    ws.on("close", () => {
      deps.listenerManager.removeConnection(ws);
    });
  });

  return wss;
}
