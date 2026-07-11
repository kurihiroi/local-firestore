import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SQLite ファイルの多重起動ガード
 *
 * better-sqlite3 の同期 API + インメモリのリスナー購読 / OCC 状態のため、
 * 同一 SQLite ファイルに対して複数のサーバープロセスを起動すると
 * リアルタイム通知・トランザクション整合性が壊れる（1 プロセス = 1 SQLite ファイル）。
 * 起動時に `<dbPath>.lock` を作成し、生存プロセスによる二重起動をエラーにする。
 * 異常終了で残った stale ロック（プロセスが死んでいる）は検出して回収する。
 */

/** 二重起動を検出したときのエラー */
export class ProcessLockError extends Error {
  constructor(lockPath: string, ownerPid: number) {
    super(
      `Another local-firestore process (pid ${ownerPid}) is already using this database ` +
        `(lock: ${lockPath}). Running multiple server processes against the same SQLite file ` +
        `breaks realtime notifications and transaction consistency. ` +
        `Stop the other process, or use a different DB_PATH.`,
    );
    this.name = "ProcessLockError";
  }
}

/** 取得済みロックのハンドル */
export interface ProcessLock {
  /** ロックファイルのパス */
  lockPath: string;
  /** ロックを解放する（プロセス終了時に呼ぶ。冪等） */
  release(): void;
}

interface LockFileContent {
  pid: number;
  acquiredAt: string;
}

/** 指定 PID のプロセスが生存しているか */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM は「存在するが操作権限がない」= 生存
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockFile(lockPath: string): LockFileContent | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as LockFileContent;
    return typeof parsed.pid === "number" ? parsed : null;
  } catch {
    return null; // 存在しない or 壊れている
  }
}

/**
 * SQLite ファイルに対するプロセスロックを取得する。
 *
 * - 生存プロセスがロックを保持している場合は `ProcessLockError` を投げる
 * - stale ロック（保持プロセスが死んでいる / 内容が壊れている）は回収して取得する
 * - `:memory:` データベースはロック不要（undefined を返す）
 */
export function acquireProcessLock(dbPath: string, pid = process.pid): ProcessLock | undefined {
  if (dbPath === ":memory:") return undefined;

  const lockPath = `${resolve(dbPath)}.lock`;
  const content: LockFileContent = { pid, acquiredAt: new Date().toISOString() };

  const tryWrite = (): boolean => {
    try {
      // wx: 既存ファイルがあれば失敗（アトミックな取得）
      writeFileSync(lockPath, JSON.stringify(content), { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  if (!tryWrite()) {
    const existing = readLockFile(lockPath);
    if (existing && existing.pid !== pid && isProcessAlive(existing.pid)) {
      throw new ProcessLockError(lockPath, existing.pid);
    }
    // stale ロック（死んだプロセス / 壊れたファイル / 自プロセスの残骸）を回収
    rmSync(lockPath, { force: true });
    if (!tryWrite()) {
      // 回収直後に他プロセスが取得した稀なレース
      const winner = readLockFile(lockPath);
      throw new ProcessLockError(lockPath, winner?.pid ?? -1);
    }
  }

  let released = false;
  return {
    lockPath,
    release() {
      if (released) return;
      released = true;
      // 自分のロックのみ削除する（回収レースで他プロセスのロックを消さない）
      const current = readLockFile(lockPath);
      if (current?.pid === pid) {
        rmSync(lockPath, { force: true });
      }
    },
  };
}
