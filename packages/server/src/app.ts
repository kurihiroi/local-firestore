import type Database from "better-sqlite3";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { type Logger, requestLogger } from "./middleware/logger.js";
import { MetricsCollector, metricsMiddleware } from "./middleware/metrics.js";
import { createAdminRoutes } from "./routes/admin-ui.js";
import { createBackupRoutes } from "./routes/backup.js";
import { createBatchRoutes } from "./routes/batch.js";
import { createDataRoutes } from "./routes/data.js";
import { createDocumentRoutes } from "./routes/documents.js";
import { createQueryRoutes } from "./routes/query.js";
import { createTriggerRoutes } from "./routes/triggers.js";
import type { AuthProvider } from "./security/auth-provider.js";
import type { SecurityRulesEngine } from "./security/rules-engine.js";
import { securityRulesMiddleware } from "./security/rules-middleware.js";
import type { DatabaseManager } from "./services/database-manager.js";
import { DEFAULT_DATABASE_ID, isValidDatabaseId } from "./services/database-manager.js";
import { DocumentService } from "./services/document.js";
import type { IndexManager } from "./services/index-manager.js";
import type { ListenerManager } from "./services/listener-manager.js";
import { QueryService } from "./services/query.js";
import { TransactionService } from "./services/transaction.js";
import type { TriggerService } from "./services/trigger.js";
import { DocumentRepository } from "./storage/repository.js";

export interface AppOptions {
  logger?: Logger;
  metricsCollector?: MetricsCollector;
  securityRules?: SecurityRulesEngine;
  authProvider?: AuthProvider;
  triggerService?: TriggerService;
  indexManager?: IndexManager;
  /** マルチデータベース対応（/databases/:databaseId/* ルーティングを有効化） */
  databaseManager?: DatabaseManager;
  /**
   * リクエストボディの最大バイト数（`MAX_REQUEST_BODY_BYTES`）。
   * 超過時は 413 を返す。デフォルト 10 MiB、0 で無効。
   */
  maxRequestBodyBytes?: number;
}

/** リクエストボディ上限のデフォルト（10 MiB。バッチ書き込みを考慮した本家 commit 相当） */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export function createApp(
  db: Database.Database,
  listenerManager?: ListenerManager,
  options?: AppOptions,
): Hono {
  const app = buildDatabaseApp(db, listenerManager, options);

  const databaseManager = options?.databaseManager;
  if (databaseManager) {
    if (!databaseManager.has(DEFAULT_DATABASE_ID)) {
      databaseManager.registerDefault(db, listenerManager);
    }

    // データベースIDごとのサブアプリ（遅延生成してキャッシュ）
    const subApps = new Map<string, Hono>();

    app.all("/databases/:databaseId/*", async (c) => {
      const databaseId = c.req.param("databaseId");
      if (!isValidDatabaseId(databaseId)) {
        return c.json({ code: "invalid-argument", message: "Invalid database ID" }, 400);
      }

      let subApp = subApps.get(databaseId);
      if (!subApp) {
        const instance = databaseManager.get(databaseId);
        // メトリクスはデータベースごとに独立させる（/databases/:id/metrics で参照可能）
        const subOptions: AppOptions = {
          ...options,
          metricsCollector: undefined,
          databaseManager: undefined,
        };
        subApp = buildDatabaseApp(instance.db, instance.listenerManager, subOptions);
        subApps.set(databaseId, subApp);
      }

      // プレフィックス（/databases/:databaseId）を除去してサブアプリへディスパッチ
      // databaseId がURLエンコードされている場合もあるためセグメント単位で除去する
      const url = new URL(c.req.url);
      const segments = url.pathname.split("/");
      url.pathname = `/${segments.slice(3).join("/")}`;
      return subApp.fetch(new Request(url, c.req.raw));
    });
  }

  return app;
}

/** 単一データベースに対するルート一式を構築する */
function buildDatabaseApp(
  db: Database.Database,
  listenerManager?: ListenerManager,
  options?: AppOptions,
): Hono {
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const transactionService = new TransactionService(db);

  const triggerService = options?.triggerService;

  const onDocumentChange =
    listenerManager || triggerService
      ? (path: string, oldDocument?: ReturnType<typeof documentService.getDocument>) => {
          listenerManager?.notifyChange(path, (p) => documentService.getDocument(p));
          const newDocument = documentService.getDocument(path);
          triggerService?.notifyChange(path, oldDocument, newDocument).catch((err) => {
            console.error("Trigger execution error:", err);
          });
        }
      : undefined;

  const app = new Hono();

  const metricsCollector = options?.metricsCollector ?? new MetricsCollector();

  // メトリクス収集
  app.use("*", metricsMiddleware(metricsCollector));

  // リクエストログ
  if (options?.logger) {
    app.use("*", requestLogger(options.logger));
  }

  // CORS
  app.use("*", cors());

  // リクエストボディサイズ上限（過負荷防御）
  const maxBodyBytes = options?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (maxBodyBytes > 0) {
    app.use(
      "*",
      bodyLimit({
        maxSize: maxBodyBytes,
        onError: (c) =>
          c.json(
            {
              code: "invalid-argument",
              message: `Request body exceeds the maximum of ${maxBodyBytes} bytes`,
            },
            413,
          ),
      }),
    );
  }

  // セキュリティルール
  if (options?.securityRules && options?.authProvider) {
    app.use(
      "*",
      securityRulesMiddleware(
        options.securityRules,
        options.authProvider,
        documentService,
        queryService,
      ),
    );
  }

  // ヘルスチェック
  app.get("/health", (c) => {
    const dbOk = isDatabaseHealthy(db);
    const status = dbOk ? "ok" : "degraded";
    const statusCode = dbOk ? 200 : 503;
    return c.json(
      {
        status,
        database: dbOk ? "ok" : "error",
        uptime: process.uptime(),
      },
      statusCode,
    );
  });

  // メトリクスエンドポイント
  app.get("/metrics", (c) => {
    return c.json(metricsCollector.getMetrics());
  });

  // ドキュメントルート
  app.route("/", createDocumentRoutes(documentService, onDocumentChange));

  // クエリルート
  app.route("/", createQueryRoutes(queryService, options?.indexManager));

  // トリガー登録ルート
  if (triggerService) {
    app.route("/", createTriggerRoutes(triggerService));
  }

  // バッチ・トランザクションルート
  app.route("/", createBatchRoutes(transactionService, onDocumentChange));

  // データエクスポート・インポートルート
  app.route("/", createDataRoutes(repo));

  // 管理画面
  app.route("/", createAdminRoutes(repo));
  app.route("/", createBackupRoutes(db));

  return app;
}

function isDatabaseHealthy(db: Database.Database): boolean {
  try {
    const result = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    return result?.ok === 1;
  } catch {
    return false;
  }
}
