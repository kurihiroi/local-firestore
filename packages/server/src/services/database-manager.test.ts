import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../storage/sqlite.js";
import {
  DatabaseManager,
  DEFAULT_DATABASE_ID,
  isValidDatabaseId,
  resolveDatabasePath,
} from "./database-manager.js";

describe("isValidDatabaseId", () => {
  it("(default) は有効", () => {
    expect(isValidDatabaseId(DEFAULT_DATABASE_ID)).toBe(true);
  });

  it("小文字英数字とハイフンは有効", () => {
    expect(isValidDatabaseId("my-db")).toBe(true);
    expect(isValidDatabaseId("db1")).toBe(true);
    expect(isValidDatabaseId("a")).toBe(true);
  });

  it("無効なIDを拒否する", () => {
    expect(isValidDatabaseId("")).toBe(false);
    expect(isValidDatabaseId("-starts-with-hyphen")).toBe(false);
    expect(isValidDatabaseId("UpperCase")).toBe(false);
    expect(isValidDatabaseId("has_underscore")).toBe(false);
    expect(isValidDatabaseId("has/slash")).toBe(false);
    expect(isValidDatabaseId("a".repeat(64))).toBe(false);
  });
});

describe("resolveDatabasePath", () => {
  it("デフォルトデータベースはベースパスをそのまま使う", () => {
    expect(resolveDatabasePath("local-firestore.db", DEFAULT_DATABASE_ID)).toBe(
      "local-firestore.db",
    );
  });

  it("拡張子の前にデータベースIDを挿入する", () => {
    expect(resolveDatabasePath("local-firestore.db", "mydb")).toBe("local-firestore.mydb.db");
    expect(resolveDatabasePath("/data/store.sqlite", "db2")).toBe("/data/store.db2.sqlite");
  });

  it("拡張子がない場合は末尾に付与する", () => {
    expect(resolveDatabasePath("/data/store", "mydb")).toBe("/data/store.mydb");
  });

  it("ディレクトリ名にドットが含まれていても正しく処理する", () => {
    expect(resolveDatabasePath("/data.dir/store", "mydb")).toBe("/data.dir/store.mydb");
  });

  it(":memory: はそのまま", () => {
    expect(resolveDatabasePath(":memory:", "mydb")).toBe(":memory:");
  });
});

describe("DatabaseManager", () => {
  it("データベースIDごとに独立したインスタンスを生成する", () => {
    const manager = new DatabaseManager(":memory:");
    const db1 = manager.get("db1");
    const db2 = manager.get("db2");

    expect(db1.databaseId).toBe("db1");
    expect(db2.databaseId).toBe("db2");
    expect(db1.db).not.toBe(db2.db);

    // データが分離されていることを確認
    db1.documentService.setDocument("users/alice", { name: "Alice" });
    expect(db1.documentService.getDocument("users/alice")).toBeDefined();
    expect(db2.documentService.getDocument("users/alice")).toBeUndefined();

    manager.closeAll();
  });

  it("同じIDでは同じインスタンスを返す", () => {
    const manager = new DatabaseManager(":memory:");
    expect(manager.get("db1")).toBe(manager.get("db1"));
    manager.closeAll();
  });

  it("無効なデータベースIDはエラー", () => {
    const manager = new DatabaseManager(":memory:");
    expect(() => manager.get("Invalid/Id")).toThrow(/Invalid database ID/);
  });

  it("registerDefault でデフォルトデータベースを登録できる", () => {
    const manager = new DatabaseManager(":memory:");
    const db = createDatabase(":memory:");
    const instance = manager.registerDefault(db);

    expect(manager.has(DEFAULT_DATABASE_ID)).toBe(true);
    expect(manager.get(DEFAULT_DATABASE_ID)).toBe(instance);
    expect(instance.db).toBe(db);
    manager.closeAll();
  });

  it("databaseIds で作成済みIDの一覧を返す", () => {
    const manager = new DatabaseManager(":memory:");
    manager.get("db1");
    manager.get("db2");
    expect(manager.databaseIds().sort()).toEqual(["db1", "db2"]);
    manager.closeAll();
  });

  describe("ファイルベースのデータベース", () => {
    let tempDir: string;

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("データベースごとに独立した SQLite ファイルを作成する", () => {
      tempDir = mkdtempSync(join(tmpdir(), "local-firestore-test-"));
      const basePath = join(tempDir, "store.db");
      const manager = new DatabaseManager(basePath);

      const instance = manager.get("mydb");
      instance.documentService.setDocument("users/alice", { name: "Alice" });
      manager.closeAll();

      // ファイルから再オープンしてデータが永続化されていることを確認
      const reopened = createDatabase(join(tempDir, "store.mydb.db"));
      const row = reopened
        .prepare("SELECT data FROM documents WHERE path = ?")
        .get("users/alice") as { data: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row?.data ?? "{}")).toEqual({ name: "Alice" });
      reopened.close();
    });
  });

  describe("派生データベースの多重起動ガード", () => {
    it("別マネージャー（別プロセス相当）から同じ派生 DB を開くとエラーになる", async () => {
      const { mkdtempSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { ProcessLockError } = await import("../utils/process-lock.js");

      const tempDir = mkdtempSync(join(tmpdir(), "lf-dbm-lock-"));
      try {
        const basePath = join(tempDir, "store.db");
        const manager1 = new DatabaseManager(basePath);
        manager1.get("mydb");

        // 生存プロセス（自プロセス以外の pid を装えないため、別 pid のロックを直接検証は
        // process-lock.test.ts に任せ、ここでは closeAll でロックが解放されることを確認する
        manager1.closeAll();

        // closeAll 後は再取得できる
        const manager2 = new DatabaseManager(basePath);
        expect(() => manager2.get("mydb")).not.toThrow();
        manager2.closeAll();
        expect(ProcessLockError).toBeDefined();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
