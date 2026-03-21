import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type Logger, requestLogger } from "./middleware/logger.js";
import { MetricsCollector, metricsMiddleware } from "./middleware/metrics.js";
import { createAdminRoutes } from "./routes/admin-ui.js";
import { createBatchRoutes } from "./routes/batch.js";
import { createDataRoutes } from "./routes/data.js";
import { createDocumentRoutes } from "./routes/documents.js";
import { createQueryRoutes } from "./routes/query.js";
import type { AuthProvider } from "./security/auth-provider.js";
import type { SecurityRulesEngine } from "./security/rules-engine.js";
import { securityRulesMiddleware } from "./security/rules-middleware.js";
import { DocumentService } from "./services/document.js";
import type { ListenerManager } from "./services/listener-manager.js";
import { QueryService } from "./services/query.js";
import { TransactionService } from "./services/transaction.js";
import { DocumentRepository } from "./storage/repository.js";

export interface AppOptions {
  logger?: Logger;
  metricsCollector?: MetricsCollector;
  securityRules?: SecurityRulesEngine;
  authProvider?: AuthProvider;
}

export function createApp(
  db: Database.Database,
  listenerManager?: ListenerManager,
  options?: AppOptions,
): Hono {
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const transactionService = new TransactionService(db);

  const onDocumentChange = listenerManager
    ? (path: string) => listenerManager.notifyChange(path, (p) => documentService.getDocument(p))
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

  // セキュリティルール
  if (options?.securityRules && options?.authProvider) {
    app.use("*", securityRulesMiddleware(options.securityRules, options.authProvider));
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
  app.route("/", createQueryRoutes(queryService));

  // バッチ・トランザクションルート
  app.route("/", createBatchRoutes(transactionService, onDocumentChange));

  // データエクスポート・インポートルート
  app.route("/", createDataRoutes(repo));

  // 管理画面
  app.route("/", createAdminRoutes(repo));

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
