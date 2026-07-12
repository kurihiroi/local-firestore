import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "./repository.js";
import { createDatabase, DatabaseOpenError } from "./sqlite.js";

describe("createDatabase の at-rest 暗号化（DB_ENCRYPTION_KEY）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lf-enc-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("暗号化 DB へ書き込み、同じ鍵で再オープンして読める", () => {
    const db = createDatabase(dbPath, { encryptionKey: "secret-key" });
    const repo = new DocumentRepository(db);
    repo.set({
      path: "users/alice",
      collectionPath: "users",
      documentId: "alice",
      data: { name: "Alice" },
    });
    db.close();

    const db2 = createDatabase(dbPath, { encryptionKey: "secret-key" });
    const repo2 = new DocumentRepository(db2);
    expect(repo2.get("users/alice")?.data).toEqual({ name: "Alice" });
    db2.close();
  });

  it("ファイルは平文の SQLite ヘッダを持たない", () => {
    const db = createDatabase(dbPath, { encryptionKey: "secret-key" });
    const repo = new DocumentRepository(db);
    repo.set({
      path: "users/alice",
      collectionPath: "users",
      documentId: "alice",
      data: { secret: "confidential" },
    });
    db.close();

    const raw = readFileSync(dbPath);
    expect(raw.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    expect(raw.includes(Buffer.from("confidential"))).toBe(false);
  });

  it("間違った鍵では DatabaseOpenError になる", () => {
    createDatabase(dbPath, { encryptionKey: "secret-key" }).close();
    expect(() => createDatabase(dbPath, { encryptionKey: "wrong-key" })).toThrow(DatabaseOpenError);
    expect(() => createDatabase(dbPath, { encryptionKey: "wrong-key" })).toThrow(
      /DB_ENCRYPTION_KEY/,
    );
  });

  it("暗号化 DB を鍵なしで開くと DatabaseOpenError になる", () => {
    createDatabase(dbPath, { encryptionKey: "secret-key" }).close();
    expect(() => createDatabase(dbPath)).toThrow(DatabaseOpenError);
    expect(() => createDatabase(dbPath)).toThrow(/may be encrypted/);
  });

  it("平文 DB を鍵付きで開くと DatabaseOpenError になる（export → import を案内）", () => {
    createDatabase(dbPath).close();
    expect(() => createDatabase(dbPath, { encryptionKey: "secret-key" })).toThrow(
      DatabaseOpenError,
    );
    expect(() => createDatabase(dbPath, { encryptionKey: "secret-key" })).toThrow(/export/);
  });

  it("鍵に ' を含んでも SQL リテラルとして安全に扱われる", () => {
    const key = "pa'ss'; DROP TABLE documents; --";
    createDatabase(dbPath, { encryptionKey: key }).close();
    const db = createDatabase(dbPath, { encryptionKey: key });
    expect(db.prepare("SELECT count(*) AS c FROM documents").get()).toEqual({ c: 0 });
    db.close();
  });

  it(":memory: では暗号化キーを無視する", () => {
    const db = createDatabase(":memory:", { encryptionKey: "secret-key" });
    expect(db.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    db.close();
  });
});
