import { DocumentValidationError } from "@local-firestore/shared";
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

  describe("deleteField センチネル（プロトコル表現）", () => {
    const deleteSentinel = { __fieldValue: true, type: "deleteField" } as const;

    it("同じ文字列値 $$__DELETE__$$ の書き込みはフィールド削除にならない", () => {
      // B-4: 旧文字列表現との衝突によるデータ破損リスクの回帰テスト
      service.setDocument("users/alice", { name: "Alice", note: "$$__DELETE__$$" });
      const doc = service.getDocument("users/alice");
      expect(doc?.data.note).toBe("$$__DELETE__$$");

      service.setDocument("users/alice", { note: "$$__DELETE__$$" }, { merge: true });
      expect(service.getDocument("users/alice")?.data.note).toBe("$$__DELETE__$$");
    });

    it("merge set でネストしたフィールドを deleteField で削除できる", () => {
      service.setDocument("users/alice", { profile: { age: 30, city: "Tokyo" } });
      service.setDocument("users/alice", { profile: { age: deleteSentinel } }, { merge: true });

      const doc = service.getDocument("users/alice");
      expect(doc?.data.profile).toEqual({ city: "Tokyo" });
    });

    it("merge なしの set で deleteField はエラーになる", () => {
      expect(() => service.setDocument("users/alice", { age: deleteSentinel })).toThrow(
        DocumentValidationError,
      );
    });

    it("addDocument で deleteField はエラーになる", () => {
      expect(() => service.addDocument("users", { age: deleteSentinel })).toThrow(
        DocumentValidationError,
      );
    });

    it("update でネストしたマップ内の deleteField はエラーになる", () => {
      service.setDocument("users/alice", { profile: { age: 30 } });
      expect(() =>
        service.updateDocument("users/alice", { profile: { age: deleteSentinel } }),
      ).toThrow(DocumentValidationError);
    });

    it("update のドット記法パスで deleteField が使える", () => {
      service.setDocument("users/alice", { profile: { age: 30, city: "Tokyo" } });
      service.updateDocument("users/alice", { "profile.age": deleteSentinel });
      expect(service.getDocument("users/alice")?.data.profile).toEqual({ city: "Tokyo" });
    });

    it("存在しないドキュメントへの merge set で deleteField は無視される", () => {
      service.setDocument("users/new", { name: "New", gone: deleteSentinel }, { merge: true });
      expect(service.getDocument("users/new")?.data).toEqual({ name: "New" });
    });
  });

  describe("プラットフォームリミット（B-1）", () => {
    it("1 MiB 超のドキュメントはエラーになる", () => {
      const big = "x".repeat(1_048_576);
      expect(() => service.setDocument("users/big", { data: big })).toThrow(
        DocumentValidationError,
      );
    });

    it("ネスト深度 20 超のドキュメントはエラーになる", () => {
      let value: unknown = 1;
      for (let i = 0; i < 21; i++) {
        value = { nested: value };
      }
      expect(() => service.setDocument("users/deep", { deep: value })).toThrow(
        DocumentValidationError,
      );
    });

    it("予約フィールド名（__.*__）はエラーになる", () => {
      expect(() => service.setDocument("users/reserved", { __name__: 1 })).toThrow(
        DocumentValidationError,
      );
    });

    it("update 結果がリミットを超える場合もエラーになる", () => {
      service.setDocument("users/u1", { a: 1 });
      const big = "x".repeat(1_048_576);
      expect(() => service.updateDocument("users/u1", { data: big })).toThrow(
        DocumentValidationError,
      );
    });
  });

  describe("Timestamp のマイクロ秒切り捨て（C-2）", () => {
    it("書き込み時にナノ秒がマイクロ秒精度に切り捨てられる", () => {
      service.setDocument("events/e1", {
        at: { __type: "timestamp", value: { seconds: 100, nanoseconds: 123_456_789 } },
      });
      expect(service.getDocument("events/e1")?.data.at).toEqual({
        __type: "timestamp",
        value: { seconds: 100, nanoseconds: 123_456_000 },
      });
    });

    it("update / merge set でも切り捨てられる", () => {
      service.setDocument("events/e1", { name: "x" });
      service.updateDocument("events/e1", {
        at: { __type: "timestamp", value: { seconds: 1, nanoseconds: 1999 } },
      });
      expect(service.getDocument("events/e1")?.data.at).toEqual({
        __type: "timestamp",
        value: { seconds: 1, nanoseconds: 1000 },
      });

      service.setDocument(
        "events/e1",
        { at2: { __type: "timestamp", value: { seconds: 2, nanoseconds: 999 } } },
        { merge: true },
      );
      expect(service.getDocument("events/e1")?.data.at2).toEqual({
        __type: "timestamp",
        value: { seconds: 2, nanoseconds: 0 },
      });
    });

    it("createTime / updateTime はマイクロ秒精度の ISO 文字列になる", () => {
      const meta = service.setDocument("events/e1", { v: 1 });
      // 小数部6桁（マイクロ秒）
      expect(meta.createTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(meta.updateTime).toMatch(/\.\d{6}Z$/);
    });
  });
});
