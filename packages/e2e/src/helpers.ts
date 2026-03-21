import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createApp, createDatabase, ListenerManager, QueryService } from "@local-firestore/server";
import { getFirestore, type Firestore } from "@local-firestore/client";

export interface TestContext {
  server: Server;
  firestore: Firestore;
  port: number;
  cleanup: () => Promise<void>;
}

/**
 * E2Eテスト用にサーバーを起動しクライアントを作成する
 */
export async function startTestServer(): Promise<TestContext> {
  const db = createDatabase(":memory:");
  const queryService = new QueryService(db);
  const listenerManager = new ListenerManager(queryService);
  const app = createApp(db, listenerManager);

  const server = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => {
      resolve(s as Server);
    });
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
