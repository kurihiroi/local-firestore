import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createBatchRoutes } from "./routes/batch.js";
import { createDocumentRoutes } from "./routes/documents.js";
import { createQueryRoutes } from "./routes/query.js";
import { DocumentService } from "./services/document.js";
import type { ListenerManager } from "./services/listener-manager.js";
import { QueryService } from "./services/query.js";
import { TransactionService } from "./services/transaction.js";
import { DocumentRepository } from "./storage/repository.js";

export function createApp(db: Database.Database, listenerManager?: ListenerManager): Hono {
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const transactionService = new TransactionService(db);

  const onDocumentChange = listenerManager
    ? (path: string) => listenerManager.notifyChange(path, (p) => documentService.getDocument(p))
    : undefined;

  const app = new Hono();

  // CORS
  app.use("*", cors());

  // ヘルスチェック
  app.get("/health", (c) => c.json({ status: "ok" }));

  // ドキュメントルート
  app.route("/", createDocumentRoutes(documentService, onDocumentChange));

  // クエリルート
  app.route("/", createQueryRoutes(queryService));

  // バッチ・トランザクションルート
  app.route("/", createBatchRoutes(transactionService, onDocumentChange));

  return app;
}
