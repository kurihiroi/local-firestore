import { getConnectionManager } from "./connection.js";
import { logDebug } from "./logger.js";
import { getWriteQueue, setNetworkEnabled } from "./network-state.js";
import { HttpTransport } from "./transport.js";
import type { Firestore } from "./types.js";

export type { LogLevel } from "./logger.js";
export { getLogLevel, setLogLevel } from "./logger.js";

export interface FirestoreSettings {
  host?: string;
  port?: number;
  ssl?: boolean;
}

const DEFAULT_SETTINGS: Required<FirestoreSettings> = {
  host: "localhost",
  port: 8080,
  ssl: false,
};

/** デフォルトデータベースのID */
const DEFAULT_DATABASE_ID = "(default)";

export function getFirestore(settings?: FirestoreSettings, databaseId?: string): Firestore;
export function getFirestore(_app: unknown, databaseId?: string): Firestore;
export function getFirestore(
  settingsOrApp?: FirestoreSettings | unknown,
  databaseId?: string,
): Firestore {
  let settings: FirestoreSettings | undefined;

  // 第1引数が FirestoreSettings かどうかを判定
  if (
    settingsOrApp === undefined ||
    settingsOrApp === null ||
    (typeof settingsOrApp === "object" &&
      ("host" in (settingsOrApp as Record<string, unknown>) ||
        "port" in (settingsOrApp as Record<string, unknown>) ||
        "ssl" in (settingsOrApp as Record<string, unknown>)))
  ) {
    settings = settingsOrApp as FirestoreSettings | undefined;
  }
  // それ以外は app オブジェクト（無視）

  const config = { ...DEFAULT_SETTINGS, ...settings };
  const resolvedDatabaseId = databaseId ?? DEFAULT_DATABASE_ID;
  // デフォルト以外のデータベースは /databases/:databaseId プレフィックス経由でアクセスする
  const basePath =
    resolvedDatabaseId === DEFAULT_DATABASE_ID
      ? ""
      : `/databases/${encodeURIComponent(resolvedDatabaseId)}`;
  const transport = new HttpTransport(config.host, config.port, config.ssl, basePath);
  return {
    type: "firestore",
    _transport: transport,
    _databaseId: resolvedDatabaseId,
  } as Firestore;
}

/**
 * initializeFirestore - Firebase互換の初期化関数
 *
 * `getFirestore` と同じ機能だが、Firebase SDKの `initializeFirestore` と
 * 同じシグネチャを持つ。`app` パラメータは互換性のために受け取るが無視する。
 */
export function initializeFirestore(_app: unknown, settings: FirestoreSettings): Firestore {
  return getFirestore(settings);
}

/** Firestore インスタンスを終了する */
export function terminate(firestore: Firestore): Promise<void> {
  const manager = getConnectionManager(firestore);
  manager.dispose();
  return Promise.resolve();
}

/**
 * ネットワーク接続を無効化する
 *
 * 無効化中の書き込みは WriteQueue にエンキューされ、
 * `enableNetwork()` 呼び出し時にまとめてサーバーへ送信される。
 */
export function disableNetwork(firestore: Firestore): Promise<void> {
  setNetworkEnabled(firestore, false);
  const manager = getConnectionManager(firestore);
  manager.disconnect();
  logDebug("Network disabled");
  return Promise.resolve();
}

/** ネットワーク接続を有効化し、キュー済みの書き込みをフラッシュする */
export async function enableNetwork(firestore: Firestore): Promise<void> {
  setNetworkEnabled(firestore, true);
  const manager = getConnectionManager(firestore);
  manager.connect();
  const queue = getWriteQueue(firestore);
  logDebug(`Network enabled, flushing ${queue.size} queued write(s)`);
  await queue.flush();
}

/** 保留中の書き込みがすべてサーバーに送信されるまで待機する */
export function waitForPendingWrites(firestore: Firestore): Promise<void> {
  return getWriteQueue(firestore).waitForDrain();
}
