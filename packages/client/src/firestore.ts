import { getConnectionManager } from "./connection.js";
import { HttpTransport } from "./transport.js";
import type { Firestore } from "./types.js";

export interface FirestoreSettings {
  host?: string;
  port?: number;
  ssl?: boolean;
}

/** ログレベル */
export type LogLevel = "debug" | "error" | "silent";

let currentLogLevel: LogLevel = "error";

const DEFAULT_SETTINGS: Required<FirestoreSettings> = {
  host: "localhost",
  port: 8080,
  ssl: false,
};

export function getFirestore(settings?: FirestoreSettings): Firestore;
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
  const transport = new HttpTransport(config.host, config.port, config.ssl);
  return {
    type: "firestore",
    _transport: transport,
    _databaseId: databaseId ?? "(default)",
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

/** ネットワーク接続を無効化する */
export function disableNetwork(firestore: Firestore): Promise<void> {
  const manager = getConnectionManager(firestore);
  manager.disconnect();
  return Promise.resolve();
}

/** ネットワーク接続を有効化する */
export function enableNetwork(firestore: Firestore): Promise<void> {
  const manager = getConnectionManager(firestore);
  manager.connect();
  return Promise.resolve();
}

/** 保留中の書き込みの完了を待機する */
export function waitForPendingWrites(_firestore: Firestore): Promise<void> {
  // ローカルエミュレータでは書き込みは即座に完了するため、常に即 resolve
  return Promise.resolve();
}

/** ログレベルを設定する */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/** @internal 現在のログレベルを取得する */
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}
