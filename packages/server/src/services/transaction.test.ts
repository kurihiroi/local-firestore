import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentService } from "./document.js";
import { TransactionConflictError, TransactionService } from "./transaction.js";

describe("TransactionService", () => {
  let db: Database.Database;
  let docService: DocumentService;
  let txnService: TransactionService;

  beforeEach(() => {
    db = createDatabase(":memory:");
    const repo = new DocumentRepository(db);
    docService = new DocumentService(repo);
    txnService = new TransactionService(db);
  });

  describe("executeBatch", () => {
    it("複数の操作をアトミックに実行できる", () => {
      txnService.executeBatch([
        { type: "set", path: "users/alice", data: { name: "Alice" } },
        { type: "set", path: "users/bob", data: { name: "Bob" } },
      ]);

      expect(docService.getDocument("users/alice")!.data).toEqual({ name: "Alice" });
      expect(docService.getDocument("users/bob")!.data).toEqual({ name: "Bob" });
    });

    it("set / update / delete を混在できる", () => {
      docService.setDocument("users/alice", { name: "Alice", age: 30 });

      txnService.executeBatch([
        { type: "update", path: "users/alice", data: { age: 31 } },
        { type: "set", path: "users/bob", data: { name: "Bob" } },
        { type: "delete", path: "users/alice" },
      ]);

      expect(docService.getDocument("users/alice")).toBeUndefined();
      expect(docService.getDocument("users/bob")!.data).toEqual({ name: "Bob" });
    });

    it("途中でエラーが発生したらすべてロールバックされる", () => {
      docService.setDocument("users/alice", { name: "Alice" });

      expect(() =>
        txnService.executeBatch([
          { type: "set", path: "users/bob", data: { name: "Bob" } },
          { type: "update", path: "users/nonexistent", data: { name: "test" } },
        ]),
      ).toThrow();

      // bobも作成されていないこと（ロールバック）
      expect(docService.getDocument("users/bob")).toBeUndefined();
      // aliceは元のまま
      expect(docService.getDocument("users/alice")!.data).toEqual({ name: "Alice" });
    });
  });

  describe("トランザクション", () => {
    it("begin → get → commit の基本フローが動く", () => {
      docService.setDocument("users/alice", { name: "Alice", balance: 100 });

      const txnId = txnService.begin();
      const doc = txnService.getDocument(txnId, "users/alice");
      expect(doc!.data.balance).toBe(100);

      txnService.commit(txnId, [{ type: "update", path: "users/alice", data: { balance: 80 } }]);

      expect(docService.getDocument("users/alice")!.data.balance).toBe(80);
    });

    it("読み取り後に他で変更されたらコンフリクトエラーになる", () => {
      docService.setDocument("users/alice", { name: "Alice", balance: 100 });

      const txnId = txnService.begin();
      txnService.getDocument(txnId, "users/alice");

      // トランザクション外で変更
      docService.setDocument("users/alice", { name: "Alice", balance: 50 });

      expect(() =>
        txnService.commit(txnId, [{ type: "update", path: "users/alice", data: { balance: 80 } }]),
      ).toThrow(TransactionConflictError);

      // 元の値（外部変更後の値）が保持されている
      expect(docService.getDocument("users/alice")!.data.balance).toBe(50);
    });

    it("存在しないドキュメントを読み取り → 他で作成された場合もコンフリクト", () => {
      const txnId = txnService.begin();
      const doc = txnService.getDocument(txnId, "users/alice");
      expect(doc).toBeUndefined();

      // トランザクション外で作成
      docService.setDocument("users/alice", { name: "Alice" });

      expect(() =>
        txnService.commit(txnId, [
          { type: "set", path: "users/alice", data: { name: "Alice from txn" } },
        ]),
      ).toThrow(TransactionConflictError);
    });

    it("rollbackでトランザクションが破棄される", () => {
      const txnId = txnService.begin();
      txnService.rollback(txnId);

      expect(() => txnService.getDocument(txnId, "users/alice")).toThrow();
    });
  });
});
