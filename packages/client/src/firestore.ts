import { HttpTransport } from "./transport.js";
import type { Firestore } from "./types.js";

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

export function getFirestore(settings?: FirestoreSettings): Firestore {
  const config = { ...DEFAULT_SETTINGS, ...settings };
  const transport = new HttpTransport(config.host, config.port, config.ssl);
  return {
    type: "firestore",
    _transport: transport,
  };
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
