import type { Server as HttpServer } from "node:http";
import type {
  ClientMessage,
  DocumentMetadata,
  SnapshotErrorMessage,
  SubscribeDocMessage,
  SubscribeQueryMessage,
} from "@local-firestore/shared";
import type { WebSocket } from "ws";
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
 * - 通常のコレクションクエリはクエリ制約からの静的証明（evaluateListStatic）で
 *   この場で1回評価し、拒否なら理由文字列を返す（本家の「ルールはフィルタでは
 *   ない」セマンティクス。ガード不要）
 * - コレクショングループクエリは実ドキュメントパスでのルールマッチが必要なため、
 *   スナップショットのドキュメント群を評価するガード関数を返す。初回スナップ
 *   ショットと以降の追加・変更ドキュメントに対して ListenerManager から
 *   呼び出され、拒否に転じた場合は購読が終了する
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

  if (collectionGroup && engine.needsPerDocumentListEvaluation(collectionPath, true)) {
    const guard: QueryRulesGuard = (docs) => {
      const result = engine.evaluateListQuery(
        { auth, collectionPath, collectionGroup, queryParams, requestTime: new Date() },
        docs,
      );
      return result.allowed ? null : (result.reason ?? "Permission denied by security rules");
    };
    return { deniedReason: null, guard };
  }

  const result = collectionGroup
    ? engine.evaluate("list", {
        auth,
        path: collectionPath,
        documentId: "",
        collectionPath,
        requestTime: new Date(),
        queryParams,
      })
    : engine.evaluateListStatic(
        { auth, collectionPath, requestTime: new Date(), queryParams },
        msg.constraints,
      );
  return {
    deniedReason: result.allowed ? null : (result.reason ?? "Permission denied by security rules"),
  };
}

/** WebSocket の過負荷防御設定 */
export interface WebSocketLimits {
  /** 同時接続数の上限（超過時は 1013 Try Again Later でクローズ）。0 で無制限（`WS_MAX_CONNECTIONS`） */
  maxConnections?: number;
  /** 受信メッセージの最大バイト数（`WS_MAX_PAYLOAD_BYTES`。超過時は ws が 1009 でクローズ） */
  maxPayloadBytes?: number;
  /** ping/pong 死活監視の間隔ミリ秒。応答のない接続は切断。0 で無効（`WS_HEARTBEAT_INTERVAL_MS`） */
  heartbeatIntervalMs?: number;
}

const DEFAULT_MAX_CONNECTIONS = 1000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB（サブスクライブメッセージには十分）
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * HTTPサーバーにWebSocketサーバーをアタッチする
 */
export function attachWebSocket(
  server: HttpServer,
  deps: WebSocketDeps,
  limits: WebSocketLimits = {},
): WebSocketServer {
  const maxConnections = limits.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const heartbeatIntervalMs = limits.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const wss = new WebSocketServer({
    server,
    maxPayload: limits.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  });

  // ping/pong 死活監視: 前回の ping に応答していない接続を切断する
  const alive = new WeakMap<WebSocket, boolean>();
  if (heartbeatIntervalMs > 0) {
    const heartbeat = setInterval(() => {
      for (const client of wss.clients) {
        if (alive.get(client) === false) {
          client.terminate();
          continue;
        }
        alive.set(client, false);
        client.ping();
      }
    }, heartbeatIntervalMs);
    heartbeat.unref?.();
    wss.on("close", () => clearInterval(heartbeat));
  }

  wss.on("connection", (ws) => {
    // 接続数上限（この接続を含めて判定）
    if (maxConnections > 0 && wss.clients.size > maxConnections) {
      ws.close(1013, "Too many connections");
      return;
    }
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    // maxPayload 超過などのプロトコルエラー。未処理だと 'error' イベントで
    // プロセスが落ちるため、ログに留める（接続は ws が自動的にクローズする）
    ws.on("error", (err) => {
      console.error("WebSocket connection error:", err.message);
    });

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
