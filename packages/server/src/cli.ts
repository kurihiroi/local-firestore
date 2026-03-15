import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { DocumentService } from "./services/document.js";
import { ListenerManager } from "./services/listener-manager.js";
import { QueryService } from "./services/query.js";
import { DocumentRepository } from "./storage/repository.js";
import { createDatabase } from "./storage/sqlite.js";
import { attachWebSocket } from "./websocket.js";

const port = Number(process.env.PORT) || 8080;
const dbPath = process.env.DB_PATH || "local-firestore.db";

const db = createDatabase(dbPath);
const repo = new DocumentRepository(db);
const documentService = new DocumentService(repo);
const queryService = new QueryService(db);
const listenerManager = new ListenerManager(queryService);

const app = createApp(db, listenerManager);

console.log(`Local Firestore server starting on port ${port}`);
console.log(`Database: ${dbPath}`);

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Server is running at http://localhost:${port}`);
}) as Server;

attachWebSocket(server, {
  listenerManager,
  getDocument: (path) => documentService.getDocument(path),
});
