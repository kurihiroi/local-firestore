import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createBatchRoutes } from "./routes/batch.js";
import { createDocumentRoutes } from "./routes/documents.js";
import { createQueryRoutes } from "./routes/query.js";
import { DocumentService } from "./services/document.js";
import { QueryService } from "./services/query.js";
import { TransactionService } from "./services/transaction.js";
import { DocumentRepository } from "./storage/repository.js";

export function createApp(db: Database.Database): Hono {
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const transactionService = new TransactionService(db);

  const app = new Hono();

  // CORS
  app.use("*", cors());

  // ヘルスチェック
  app.get("/health", (c) => c.json({ status: "ok" }));

  // ドキュメントルート
  app.route("/", createDocumentRoutes(documentService));

  // クエリルート
  app.route("/", createQueryRoutes(queryService));

  // バッチ・トランザクションルート
  app.route("/", createBatchRoutes(transactionService));

  return app;
}
