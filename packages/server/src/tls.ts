import { readFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";

export interface TlsOptions {
  certPath: string;
  keyPath: string;
}

/**
 * TLS証明書を読み込む
 * @throws ファイルが見つからない場合
 */
export function loadTlsCertificates(options: TlsOptions): { cert: string; key: string } {
  const cert = readFileSync(options.certPath, "utf-8");
  const key = readFileSync(options.keyPath, "utf-8");
  return { cert, key };
}

/**
 * HTTPSサーバーを作成して起動する
 */
export function createTlsServer(
  app: Hono,
  tlsOptions: TlsOptions,
  port: number,
  callback?: () => void,
): HttpsServer {
  const { cert, key } = loadTlsCertificates(tlsOptions);
  const server = createHttpsServer({ cert, key }, getRequestListener(app.fetch));
  server.listen(port, callback);
  return server;
}

/**
 * 環境変数からTLSオプションを取得する
 * TLS_CERT_PATH と TLS_KEY_PATH が両方設定されている場合のみ有効
 */
export function getTlsOptionsFromEnv(): TlsOptions | undefined {
  const certPath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;
  if (certPath && keyPath) {
    return { certPath, keyPath };
  }
  return undefined;
}
