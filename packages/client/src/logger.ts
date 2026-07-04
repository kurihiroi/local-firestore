/** ログレベル */
export type LogLevel = "debug" | "error" | "silent";

let currentLogLevel: LogLevel = "error";

/** ログレベルを設定する */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/** @internal 現在のログレベルを取得する */
export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

/** @internal debug レベルのログを出力する */
export function logDebug(message: string, ...args: unknown[]): void {
  if (currentLogLevel === "debug") {
    console.debug(`[Firestore] ${message}`, ...args);
  }
}

/** @internal error レベルのログを出力する */
export function logError(message: string, ...args: unknown[]): void {
  if (currentLogLevel !== "silent") {
    console.error(`[Firestore] ${message}`, ...args);
  }
}
