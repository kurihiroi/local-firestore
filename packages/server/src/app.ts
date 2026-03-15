import { Hono } from "hono";
import type Database from "better-sqlite3";
import { DocumentRepository } from "./storage/repository.js";
import { DocumentService } from "./services/document.js";
import { createDocumentRoutes } from "./routes/documents.js";

export function createApp(db: Database.Database): Hono {
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);

  const app = new Hono();

  // ヘルスチェック
  app.get("/health", (c) => c.json({ status: "ok" }));

  // ドキュメントルート
  app.route("/", createDocumentRoutes(documentService));

  return app;
}
