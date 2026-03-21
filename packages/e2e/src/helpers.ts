import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { type Firestore, getFirestore } from "@local-firestore/client";
import type { AppOptions, SecurityRules } from "@local-firestore/server";
import {
  attachWebSocket,
  createApp,
  createDatabase,
  DocumentRepository,
  DocumentService,
  ListenerManager,
  LocalAuthProvider,
  QueryService,
  SecurityRulesEngine,
} from "@local-firestore/server";

export interface TestContext {
  server: Server;
  firestore: Firestore;
  port: number;
  cleanup: () => Promise<void>;
}

export interface TestServerOptions {
  securityRules?: SecurityRules;
}

/**
 * E2Eテスト用にサーバーを起動しクライアントを作成する
 */
export async function startTestServer(options?: TestServerOptions): Promise<TestContext> {
  const db = createDatabase(":memory:");
  const repo = new DocumentRepository(db);
  const documentService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const listenerManager = new ListenerManager(queryService);

  const appOptions: AppOptions = {};
  if (options?.securityRules) {
    appOptions.securityRules = new SecurityRulesEngine(options.securityRules, {
      getDocument: (path) => {
        const doc = documentService.getDocument(path);
        return doc ? (doc.data as Record<string, unknown>) : null;
      },
    });
    appOptions.authProvider = new LocalAuthProvider();
  }

  const app = createApp(db, listenerManager, appOptions);

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => {
      resolve(s as Server);
    });
  });

  attachWebSocket(server, {
    listenerManager,
    getDocument: (path) => documentService.getDocument(path),
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const firestore = getFirestore({ host: "localhost", port });

  return {
    server,
    firestore,
    port,
    cleanup: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
