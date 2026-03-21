import { describe, expect, it } from "vitest";
import { SnapshotCache } from "./snapshot-cache.js";

describe("SnapshotCache", () => {
  describe("document cache", () => {
    it("should cache and retrieve a document", () => {
      const cache = new SnapshotCache();
      cache.putDocument(
        "users/u1",
        true,
        { name: "Alice" },
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
      );

      const doc = cache.getDocument("users/u1");
      expect(doc).toBeDefined();
      expect(doc!.exists).toBe(true);
      expect(doc!.data).toEqual({ name: "Alice" });
    });

    it("should return undefined for uncached documents", () => {
      const cache = new SnapshotCache();
      expect(cache.getDocument("users/u1")).toBeUndefined();
    });

    it("should overwrite existing cache", () => {
      const cache = new SnapshotCache();
      cache.putDocument("users/u1", true, { name: "Alice" }, "t1", "t1");
      cache.putDocument("users/u1", true, { name: "Bob" }, "t1", "t2");

      expect(cache.getDocument("users/u1")!.data).toEqual({ name: "Bob" });
    });

    it("should cache non-existent documents", () => {
      const cache = new SnapshotCache();
      cache.putDocument("users/u1", false, null, null, null);

      const doc = cache.getDocument("users/u1");
      expect(doc!.exists).toBe(false);
      expect(doc!.data).toBeNull();
    });

    it("should remove a document from cache", () => {
      const cache = new SnapshotCache();
      cache.putDocument("users/u1", true, { name: "Alice" }, "t1", "t1");
      cache.removeDocument("users/u1");
      expect(cache.getDocument("users/u1")).toBeUndefined();
    });

    it("should track document count", () => {
      const cache = new SnapshotCache();
      expect(cache.documentCount).toBe(0);

      cache.putDocument("users/u1", true, { name: "Alice" }, "t1", "t1");
      expect(cache.documentCount).toBe(1);

      cache.putDocument("users/u2", true, { name: "Bob" }, "t1", "t1");
      expect(cache.documentCount).toBe(2);
    });
  });

  describe("query cache", () => {
    it("should cache and retrieve a query", () => {
      const cache = new SnapshotCache();
      const docs = [
        {
          path: "users/u1",
          exists: true,
          data: { name: "Alice" },
          createTime: "t1",
          updateTime: "t1",
          cachedAt: Date.now(),
        },
        {
          path: "users/u2",
          exists: true,
          data: { name: "Bob" },
          createTime: "t1",
          updateTime: "t1",
          cachedAt: Date.now(),
        },
      ];
      cache.putQuery("users:all", docs);

      const cached = cache.getQuery("users:all");
      expect(cached).toBeDefined();
      expect(cached!.docs).toHaveLength(2);
    });

    it("should return undefined for uncached queries", () => {
      const cache = new SnapshotCache();
      expect(cache.getQuery("nonexistent")).toBeUndefined();
    });

    it("should also cache individual documents from query", () => {
      const cache = new SnapshotCache();
      const docs = [
        {
          path: "users/u1",
          exists: true,
          data: { name: "Alice" },
          createTime: "t1",
          updateTime: "t1",
          cachedAt: Date.now(),
        },
      ];
      cache.putQuery("users:all", docs);

      expect(cache.getDocument("users/u1")).toBeDefined();
      expect(cache.getDocument("users/u1")!.data).toEqual({ name: "Alice" });
    });

    it("should track query count", () => {
      const cache = new SnapshotCache();
      expect(cache.queryCount).toBe(0);

      cache.putQuery("q1", []);
      expect(cache.queryCount).toBe(1);
    });
  });

  describe("clear", () => {
    it("should clear all caches", () => {
      const cache = new SnapshotCache();
      cache.putDocument("users/u1", true, { name: "Alice" }, "t1", "t1");
      cache.putQuery("q1", []);

      cache.clear();
      expect(cache.documentCount).toBe(0);
      expect(cache.queryCount).toBe(0);
    });
  });
});
