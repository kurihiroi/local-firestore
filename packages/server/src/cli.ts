import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import type { LogLevel } from "./middleware/logger.js";
import { JsonLogOutput, Logger } from "./middleware/logger.js";
import type { AuthProvider } from "./security/auth-provider.js";
import { LocalAuthProvider } from "./security/auth-provider.js";
import { DocumentService } from "./services/document.js";
import { ListenerManager } from "./services/listener-manager.js";
import { QueryService } from "./services/query.js";
import { DocumentRepository } from "./storage/repository.js";
import { createDatabase } from "./storage/sqlite.js";
import { createTlsServer, getTlsOptionsFromEnv } from "./tls.js";
import { attachWebSocket } from "./websocket.js";

async function createAuthProvider(logger: Logger): Promise<AuthProvider> {
  if (process.env.AUTH_PROVIDER === "firebase") {
    const { initializeApp } = await import("firebase-admin/app");
    const { getAuth } = await import("firebase-admin/auth");
    const { FirebaseAuthProvider } = await import("./security/firebase-auth-provider.js");
    const firebaseApp = initializeApp();
    logger.info("Using Firebase Auth provider");
    return new FirebaseAuthProvider(getAuth(firebaseApp));
  }
  logger.info("Using Local Auth provider");
  return new LocalAuthProvider();
}

async function main() {
  const port = Number(process.env.PORT) || 8080;
  const dbPath = process.env.DB_PATH || "local-firestore.db";
  const logLevel = (process.env.LOG_LEVEL || "info") as LogLevel;
  const logFormat = process.env.LOG_FORMAT || "text";
  const tlsOptions = getTlsOptionsFromEnv();

  const logger = new Logger({
    level: logLevel,
    output: logFormat === "json" ? new JsonLogOutput() : undefined,
  });

  const db = createDatabase(dbPath);
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const listenerManager = new ListenerManager(queryService);

  const authProvider = await createAuthProvider(logger);

  const app = createApp(db, listenerManager, { logger, authProvider });

  logger.info("Local Firestore server starting", { port, dbPath, logLevel, tls: !!tlsOptions });

  let server: Server;

  if (tlsOptions) {
    server = createTlsServer(app, tlsOptions, port, () => {
      logger.info(`Server is running at https://localhost:${port}`);
    });
  } else {
    server = serve({ fetch: app.fetch, port }, () => {
      logger.info(`Server is running at http://localhost:${port}`);
    }) as Server;
  }

  attachWebSocket(server, {
    listenerManager,
    getDocument: (path) => documentService.getDocument(path),
  });
}

main();
