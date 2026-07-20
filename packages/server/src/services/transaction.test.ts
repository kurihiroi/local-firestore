import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentService } from "./document.js";
import {
  TransactionConflictError,
  TransactionExpiredError,
  TransactionService,
} from "./transaction.js";

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

    it("set の options（merge）を適用する", () => {
      docService.setDocument("users/alice", { name: "Alice", age: 30 });

      txnService.executeBatch([
        {
          type: "set",
          path: "users/alice",
          data: { age: 31 },
          options: { merge: true },
        },
      ]);

      // merge なので既存フィールドが保持される
      expect(docService.getDocument("users/alice")!.data).toEqual({ name: "Alice", age: 31 });
    });

    it("コミット内の全 serverTimestamp が単一時刻に統一される", () => {
      const serverTimestamp = { __fieldValue: true, type: "serverTimestamp" };
      txnService.executeBatch([
        { type: "set", path: "users/alice", data: { createdAt: serverTimestamp } },
        { type: "set", path: "users/bob", data: { createdAt: serverTimestamp } },
        { type: "set", path: "users/carol", data: { createdAt: serverTimestamp } },
      ]);

      const alice = docService.getDocument("users/alice")!.data.createdAt;
      const bob = docService.getDocument("users/bob")!.data.createdAt;
      const carol = docService.getDocument("users/carol")!.data.createdAt;
      expect(bob).toEqual(alice);
      expect(carol).toEqual(alice);
    });

    it("options なしの set は全上書きする", () => {
      docService.setDocument("users/alice", { name: "Alice", age: 30 });

      txnService.executeBatch([{ type: "set", path: "users/alice", data: { age: 31 } }]);

      expect(docService.getDocument("users/alice")!.data).toEqual({ age: 31 });
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

  describe("トランザクション内クエリの競合検査", () => {
    beforeEach(() => {
      docService.setDocument("items/a", { category: "food", stock: 10 });
      docService.setDocument("items/b", { category: "food", stock: 5 });
      docService.setDocument("items/c", { category: "tools", stock: 3 });
    });

    const foodQuery = [{ type: "where", fieldPath: "category", op: "==", value: "food" } as const];

    it("query → commit の基本フローが動く（結果集合が不変ならコミット成功）", () => {
      const txnId = txnService.begin();
      const docs = txnService.query(txnId, "items", foodQuery);
      expect(docs.map((d) => d.path).sort()).toEqual(["items/a", "items/b"]);

      txnService.commit(txnId, [{ type: "update", path: "items/a", data: { stock: 9 } }]);

      expect(docService.getDocument("items/a")!.data.stock).toBe(9);
    });

    it("クエリ結果のドキュメントが変更されたらコンフリクト", () => {
      const txnId = txnService.begin();
      txnService.query(txnId, "items", foodQuery);

      // トランザクション外で結果集合内のドキュメントを更新
      docService.updateDocument("items/b", { stock: 4 });

      expect(() =>
        txnService.commit(txnId, [{ type: "update", path: "items/a", data: { stock: 9 } }]),
      ).toThrow(TransactionConflictError);
    });

    it("クエリに合致する新規ドキュメント（ファントム挿入）でコンフリクト", () => {
      const txnId = txnService.begin();
      txnService.query(txnId, "items", foodQuery);

      // トランザクション外で結果集合に加わるドキュメントを作成
      docService.setDocument("items/d", { category: "food", stock: 1 });

      expect(() =>
        txnService.commit(txnId, [{ type: "update", path: "items/a", data: { stock: 9 } }]),
      ).toThrow(TransactionConflictError);
    });

    it("クエリ結果のドキュメントが削除されたらコンフリクト", () => {
      const txnId = txnService.begin();
      txnService.query(txnId, "items", foodQuery);

      docService.deleteDocument("items/b");

      expect(() =>
        txnService.commit(txnId, [{ type: "update", path: "items/a", data: { stock: 9 } }]),
      ).toThrow(TransactionConflictError);
    });

    it("クエリに合致しない無関係な変更はコンフリクトにならない", () => {
      const txnId = txnService.begin();
      txnService.query(txnId, "items", foodQuery);

      // 結果集合外（category: tools）の変更は影響しない
      docService.updateDocument("items/c", { stock: 2 });
      docService.setDocument("items/e", { category: "tools", stock: 7 });

      txnService.commit(txnId, [{ type: "update", path: "items/a", data: { stock: 9 } }]);

      expect(docService.getDocument("items/a")!.data.stock).toBe(9);
    });

    it("クエリ競合も conflictCount に計上される", () => {
      const before = txnService.conflictCount;

      const txnId = txnService.begin();
      txnService.query(txnId, "items", foodQuery);
      docService.setDocument("items/d", { category: "food", stock: 1 });

      expect(() => txnService.commit(txnId, [])).toThrow(TransactionConflictError);
      expect(txnService.conflictCount).toBe(before + 1);
    });
  });

  describe("有効期限（TTL）", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("デフォルトでは 30 秒経過しても期限切れにならない（本家準拠の約 270 秒）", () => {
      vi.useFakeTimers();
      docService.setDocument("users/alice", { name: "Alice" });

      const txnId = txnService.begin();
      vi.advanceTimersByTime(60_000);

      expect(txnService.getDocument(txnId, "users/alice")!.data).toEqual({ name: "Alice" });
    });

    it("デフォルト TTL（270 秒）を超えると期限切れになる", () => {
      vi.useFakeTimers();
      const txnId = txnService.begin();
      vi.advanceTimersByTime(271_000);

      expect(() => txnService.getDocument(txnId, "users/alice")).toThrow(TransactionExpiredError);
    });

    it("ttlMs オプションで有効期限を変更できる", () => {
      vi.useFakeTimers();
      const shortTxnService = new TransactionService(db, { ttlMs: 1_000 });
      try {
        const txnId = shortTxnService.begin();
        vi.advanceTimersByTime(1_001);

        expect(() => shortTxnService.getDocument(txnId, "users/alice")).toThrow(
          TransactionExpiredError,
        );
      } finally {
        shortTxnService.dispose();
      }
    });
  });
});
