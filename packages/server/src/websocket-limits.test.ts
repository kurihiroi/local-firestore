import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ListenerManager } from "./services/listener-manager.js";
import { QueryService } from "./services/query.js";
import { createDatabase } from "./storage/sqlite.js";
import { attachWebSocket, type WebSocketLimits } from "./websocket.js";

async function startWsServer(limits: WebSocketLimits): Promise<{ server: Server; port: number }> {
  const db = createDatabase(":memory:");
  const server = createServer();
  attachWebSocket(
    server,
    {
      listenerManager: new ListenerManager(new QueryService(db)),
      getDocument: () => undefined,
    },
    limits,
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.on("close", (code) => resolve(code));
  });
}

describe("WebSocket 過負荷防御", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it("接続数上限を超えた接続は 1013（Try Again Later）でクローズされる", async () => {
    const started = await startWsServer({ maxConnections: 1, heartbeatIntervalMs: 0 });
    server = started.server;

    const ws1 = new WebSocket(`ws://127.0.0.1:${started.port}`);
    await waitForOpen(ws1);

    const ws2 = new WebSocket(`ws://127.0.0.1:${started.port}`);
    const closeCode = await waitForClose(ws2);

    expect(closeCode).toBe(1013);
    expect(ws1.readyState).toBe(WebSocket.OPEN);
    ws1.close();
  });

  it("maxPayload を超えるメッセージを送った接続は 1009 でクローズされる", async () => {
    const started = await startWsServer({ maxPayloadBytes: 64, heartbeatIntervalMs: 0 });
    server = started.server;

    const ws = new WebSocket(`ws://127.0.0.1:${started.port}`);
    await waitForOpen(ws);
    ws.send("x".repeat(1024));
    const closeCode = await waitForClose(ws);

    // 1009: Message Too Big
    expect(closeCode).toBe(1009);
  });

  it("上限内のメッセージは処理される（エラー応答が返る = 接続維持）", async () => {
    const started = await startWsServer({ maxPayloadBytes: 1024, heartbeatIntervalMs: 0 });
    server = started.server;

    const ws = new WebSocket(`ws://127.0.0.1:${started.port}`);
    await waitForOpen(ws);
    ws.send("not-json");
    const reply = await new Promise<string>((resolve) =>
      ws.on("message", (data) => resolve(String(data))),
    );
    expect(JSON.parse(reply)).toMatchObject({ type: "error" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
