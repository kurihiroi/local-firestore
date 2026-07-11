import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireProcessLock, ProcessLockError } from "./process-lock.js";

describe("acquireProcessLock", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lf-lock-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(":memory: はロック不要", () => {
    expect(acquireProcessLock(":memory:")).toBeUndefined();
  });

  it("ロックファイルを作成し、release で削除する", () => {
    const lock = acquireProcessLock(dbPath);
    expect(lock).toBeDefined();
    expect(existsSync(`${dbPath}.lock`)).toBe(true);

    const content = JSON.parse(readFileSync(`${dbPath}.lock`, "utf-8")) as { pid: number };
    expect(content.pid).toBe(process.pid);

    lock?.release();
    expect(existsSync(`${dbPath}.lock`)).toBe(false);
    // release は冪等
    lock?.release();
  });

  it("生存プロセスがロック保持中は ProcessLockError になる", () => {
    // 自プロセスとは別の「生存している」PID としてロックを偽装する
    // （PID 1 は常に存在する init/PID namespace の先頭プロセス）
    writeFileSync(
      `${dbPath}.lock`,
      JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() }),
    );
    expect(() => acquireProcessLock(dbPath)).toThrow(ProcessLockError);
    expect(() => acquireProcessLock(dbPath)).toThrow(/pid 1/);
  });

  it("死んだプロセスの stale ロックは回収して取得できる", () => {
    // 終了済みプロセスの実 PID を取得する
    const child = spawnSync("node", ["-e", ""], { stdio: "ignore" });
    const deadPid = child.pid ?? 999_999;

    writeFileSync(
      `${dbPath}.lock`,
      JSON.stringify({ pid: deadPid, acquiredAt: new Date().toISOString() }),
    );

    const lock = acquireProcessLock(dbPath);
    expect(lock).toBeDefined();
    const content = JSON.parse(readFileSync(`${dbPath}.lock`, "utf-8")) as { pid: number };
    expect(content.pid).toBe(process.pid);
    lock?.release();
  });

  it("壊れたロックファイルは回収して取得できる", () => {
    writeFileSync(`${dbPath}.lock`, "not-json");
    const lock = acquireProcessLock(dbPath);
    expect(lock).toBeDefined();
    lock?.release();
  });

  it("release は他プロセスが取得し直したロックを消さない", () => {
    const lock = acquireProcessLock(dbPath, 12345_678);
    expect(lock).toBeDefined();
    // 別プロセスがロックを取り直した状況を偽装
    writeFileSync(
      `${dbPath}.lock`,
      JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() }),
    );
    lock?.release();
    expect(existsSync(`${dbPath}.lock`)).toBe(true);
  });
});
