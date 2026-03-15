import { beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentNotFoundError, DocumentService } from "./document.js";

describe("DocumentService", () => {
  let service: DocumentService;

  beforeEach(() => {
    const db = createDatabase(":memory:");
    const repo = new DocumentRepository(db);
    service = new DocumentService(repo);
  });

  describe("setDocument / getDocument", () => {
    it("ドキュメントを作成して取得できる", () => {
      service.setDocument("users/alice", { name: "Alice", age: 30 });

      const doc = service.getDocument("users/alice");
      expect(doc).toBeDefined();
      expect(doc?.data).toEqual({ name: "Alice", age: 30 });
      expect(doc?.documentId).toBe("alice");
      expect(doc?.collectionPath).toBe("users");
    });

    it("既存ドキュメントを上書きできる", () => {
      service.setDocument("users/alice", { name: "Alice" });
      service.setDocument("users/alice", { name: "Alice Updated", age: 31 });

      const doc = service.getDocument("users/alice");
      expect(doc?.data).toEqual({ name: "Alice Updated", age: 31 });
      expect(doc?.version).toBe(2);
    });

    it("存在しないドキュメントはundefinedを返す", () => {
      const doc = service.getDocument("users/nonexistent");
      expect(doc).toBeUndefined();
    });

    it("サブコレクションのドキュメントを扱える", () => {
      service.setDocument("users/alice/posts/post1", { title: "Hello" });

      const doc = service.getDocument("users/alice/posts/post1");
      expect(doc).toBeDefined();
      expect(doc?.collectionPath).toBe("users/alice/posts");
      expect(doc?.documentId).toBe("post1");
    });
  });

  describe("addDocument", () => {
    it("自動生成IDでドキュメントを追加できる", () => {
      const doc = service.addDocument("users", { name: "Bob" });

      expect(doc.documentId).toHaveLength(20);
      expect(doc.path).toBe(`users/${doc.documentId}`);
      expect(doc.data).toEqual({ name: "Bob" });
    });
  });

  describe("updateDocument", () => {
    it("既存ドキュメントを部分更新できる", () => {
      service.setDocument("users/alice", { name: "Alice", age: 30 });
      service.updateDocument("users/alice", { age: 31 });

      const doc = service.getDocument("users/alice");
      expect(doc?.data).toEqual({ name: "Alice", age: 31 });
    });

    it("存在しないドキュメントの更新はエラーになる", () => {
      expect(() => service.updateDocument("users/nonexistent", { name: "test" })).toThrow(
        DocumentNotFoundError,
      );
    });
  });

  describe("deleteDocument", () => {
    it("ドキュメントを削除できる", () => {
      service.setDocument("users/alice", { name: "Alice" });
      const result = service.deleteDocument("users/alice");

      expect(result).toBe(true);
      expect(service.getDocument("users/alice")).toBeUndefined();
    });

    it("存在しないドキュメントの削除はfalseを返す", () => {
      const result = service.deleteDocument("users/nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("FieldValue解決", () => {
    it("serverTimestampが現在時刻に解決される", () => {
      const before = Math.floor(Date.now() / 1000);
      service.setDocument("users/alice", {
        name: "Alice",
        createdAt: { __fieldValue: true, type: "serverTimestamp" },
      });
      const after = Math.floor(Date.now() / 1000);

      const doc = service.getDocument("users/alice");
      const ts = doc?.data.createdAt as { __type: string; value: { seconds: number } };
      expect(ts.__type).toBe("timestamp");
      expect(ts.value.seconds).toBeGreaterThanOrEqual(before);
      expect(ts.value.seconds).toBeLessThanOrEqual(after);
    });

    it("deleteFieldでフィールドが削除される", () => {
      service.setDocument("users/alice", { name: "Alice", age: 30 });
      service.updateDocument("users/alice", {
        age: { __fieldValue: true, type: "deleteField" },
      });

      const doc = service.getDocument("users/alice");
      expect(doc?.data).toEqual({ name: "Alice" });
      expect(doc?.data.age).toBeUndefined();
    });

    it("incrementでフィールド値が加算される", () => {
      service.setDocument("users/alice", { name: "Alice", score: 10 });
      service.updateDocument("users/alice", {
        score: { __fieldValue: true, type: "increment", value: 5 },
      });

      const doc = service.getDocument("users/alice");
      expect(doc?.data.score).toBe(15);
    });

    it("arrayUnionで配列にユニーク要素が追加される", () => {
      service.setDocument("users/alice", { tags: ["a", "b"] });
      service.updateDocument("users/alice", {
        tags: { __fieldValue: true, type: "arrayUnion", value: ["b", "c"] },
      });

      const doc = service.getDocument("users/alice");
      expect(doc?.data.tags).toEqual(["a", "b", "c"]);
    });

    it("arrayRemoveで配列から要素が除去される", () => {
      service.setDocument("users/alice", { tags: ["a", "b", "c"] });
      service.updateDocument("users/alice", {
        tags: { __fieldValue: true, type: "arrayRemove", value: ["b"] },
      });

      const doc = service.getDocument("users/alice");
      expect(doc?.data.tags).toEqual(["a", "c"]);
    });
  });
});
