import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { type Firestore, getFirestore } from "@local-firestore/client";
import type { AppOptions, SecurityRules } from "@local-firestore/server";
import {
  attachWebSocket,
  createApp,
  createDatabase,
  DatabaseManager,
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
  /** 指定したデータベースIDに接続する Firestore インスタンスを作成する */
  createFirestore: (databaseId: string) => Firestore;
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
  const databaseManager = new DatabaseManager(":memory:");

  const appOptions: AppOptions = { databaseManager };
  let securityRulesEngine: SecurityRulesEngine | undefined;
  let authProvider: LocalAuthProvider | undefined;
  if (options?.securityRules) {
    securityRulesEngine = new SecurityRulesEngine(options.securityRules, {
      getDocument: (path) => {
        // ルール式の get()/exists() は `/databases/<dbId>/documents/<docPath>` 形式の
        // 完全パスを渡してくるため、ドキュメントパスへ変換する
        const docPath = path.replace(/^\/databases\/[^/]+\/documents\//, "");
        const doc = documentService.getDocument(docPath);
        return doc ? (doc.data as Record<string, unknown>) : null;
      },
    });
    authProvider = new LocalAuthProvider();
    appOptions.securityRules = securityRulesEngine;
    appOptions.authProvider = authProvider;
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
    securityRules: securityRulesEngine,
    authProvider,
    resolveDatabase: (databaseId) => {
      const instance = databaseManager.get(databaseId);
      return {
        listenerManager: instance.listenerManager,
        getDocument: (path) => instance.documentService.getDocument(path),
      };
    },
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  const firestore = getFirestore({ host: "localhost", port });

  return {
    server,
    firestore,
    port,
    createFirestore: (databaseId) => getFirestore({ host: "localhost", port }, databaseId),
    cleanup: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
