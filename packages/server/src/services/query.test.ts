import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentRepository } from "../storage/repository.js";
import { DocumentService } from "./document.js";
import { QueryService } from "./query.js";
import type Database from "better-sqlite3";

describe("QueryService", () => {
  let db: Database.Database;
  let docService: DocumentService;
  let queryService: QueryService;

  beforeEach(() => {
    db = createDatabase(":memory:");
    const repo = new DocumentRepository(db);
    docService = new DocumentService(repo);
    queryService = new QueryService(db);

    // テストデータ投入
    docService.setDocument("users/alice", { name: "Alice", age: 30, status: "active", tags: ["ts", "node"] });
    docService.setDocument("users/bob", { name: "Bob", age: 25, status: "inactive", tags: ["python"] });
    docService.setDocument("users/charlie", { name: "Charlie", age: 35, status: "active", tags: ["ts", "go"] });
    docService.setDocument("users/dave", { name: "Dave", age: 28, status: "active", tags: ["node", "rust"] });
  });

  describe("基本クエリ", () => {
    it("コレクション内の全ドキュメントを取得できる", () => {
      const results = queryService.executeQuery("users", []);
      expect(results).toHaveLength(4);
    });

    it("空のコレクションは空配列を返す", () => {
      const results = queryService.executeQuery("posts", []);
      expect(results).toHaveLength(0);
    });
  });

  describe("whereフィルタ", () => {
    it("== フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "status", op: "==", value: "active" },
      ]);
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie", "dave"]);
    });

    it("!= フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "status", op: "!=", value: "active" },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("bob");
    });

    it("> フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: ">", value: 28 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie"]);
    });

    it(">= フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: ">=", value: 30 },
      ]);
      expect(results).toHaveLength(2);
    });

    it("< フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: "<", value: 28 },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("bob");
    });

    it("<= フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "age", op: "<=", value: 28 },
      ]);
      expect(results).toHaveLength(2);
    });

    it("in フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "name", op: "in", value: ["Alice", "Bob"] },
      ]);
      expect(results).toHaveLength(2);
    });

    it("not-in フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "name", op: "not-in", value: ["Alice", "Bob"] },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["charlie", "dave"]);
    });

    it("array-contains フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "tags", op: "array-contains", value: "ts" },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie"]);
    });

    it("array-contains-any フィルタ", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "tags", op: "array-contains-any", value: ["python", "rust"] },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["bob", "dave"]);
    });

    it("複数のwhereフィルタを組み合わせられる", () => {
      const results = queryService.executeQuery("users", [
        { type: "where", fieldPath: "status", op: "==", value: "active" },
        { type: "where", fieldPath: "age", op: ">=", value: 30 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["alice", "charlie"]);
    });
  });

  describe("orderBy", () => {
    it("昇順ソート", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave", "alice", "charlie"]);
    });

    it("降順ソート", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "desc" },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["charlie", "alice", "dave", "bob"]);
    });
  });

  describe("limit", () => {
    it("limit で件数制限できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "limit", limit: 2 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave"]);
    });

    it("limitToLast で末尾から取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "limitToLast", limit: 2 },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId)).toEqual(["alice", "charlie"]);
    });
  });

  describe("カーソル", () => {
    it("startAt で指定値以降を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "startAt", values: [30] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["alice", "charlie"]);
    });

    it("startAfter で指定値より後を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "startAfter", values: [28] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["alice", "charlie"]);
    });

    it("endAt で指定値以前を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "endAt", values: [28] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave"]);
    });

    it("endBefore で指定値より前を取得できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "endBefore", values: [30] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["bob", "dave"]);
    });

    it("startAfter + endBefore で範囲指定できる", () => {
      const results = queryService.executeQuery("users", [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "startAfter", values: [25] },
        { type: "endBefore", values: [35] },
      ]);
      expect(results.map((r) => r.documentId)).toEqual(["dave", "alice"]);
    });
  });

  describe("複合フィルタ", () => {
    it("AND複合フィルタ", () => {
      const results = queryService.executeQuery("users", [
        {
          type: "and",
          filters: [
            { type: "where", fieldPath: "status", op: "==", value: "active" },
            { type: "where", fieldPath: "age", op: "<", value: 30 },
          ],
        },
      ]);
      expect(results).toHaveLength(1);
      expect(results[0].documentId).toBe("dave");
    });

    it("OR複合フィルタ", () => {
      const results = queryService.executeQuery("users", [
        {
          type: "or",
          filters: [
            { type: "where", fieldPath: "age", op: "==", value: 25 },
            { type: "where", fieldPath: "age", op: "==", value: 35 },
          ],
        },
      ]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.documentId).sort()).toEqual(["bob", "charlie"]);
    });
  });

  describe("コレクショングループクエリ", () => {
    beforeEach(() => {
      docService.setDocument("users/alice/posts/post1", { title: "Hello", likes: 10 });
      docService.setDocument("users/bob/posts/post2", { title: "World", likes: 5 });
      docService.setDocument("groups/dev/posts/post3", { title: "Dev", likes: 20 });
    });

    it("全サブコレクションからドキュメントを取得できる", () => {
      const results = queryService.executeQuery("posts", [], true);
      expect(results).toHaveLength(3);
    });

    it("コレクショングループクエリにwhereフィルタを適用できる", () => {
      const results = queryService.executeQuery(
        "posts",
        [{ type: "where", fieldPath: "likes", op: ">=", value: 10 }],
        true,
      );
      expect(results).toHaveLength(2);
    });
  });
});
