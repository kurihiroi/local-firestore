import type { ExportResponse, ImportResponse } from "@local-firestore/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("Data Export/Import Routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  describe("GET /export", () => {
    it("空のデータベースをエクスポートできる", async () => {
      const res = await request(app, "GET", "/export");
      expect(res.status).toBe(200);

      const body = await jsonBody<ExportResponse>(res);
      expect(body.version).toBe(1);
      expect(body.exportedAt).toBeDefined();
      expect(body.documents).toEqual([]);
    });

    it("全ドキュメントをエクスポートできる", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", age: 30 },
      });
      await request(app, "PUT", "/docs/users/bob", {
        data: { name: "Bob", age: 25 },
      });
      await request(app, "PUT", "/docs/posts/post1", {
        data: { title: "Hello" },
      });

      const res = await request(app, "GET", "/export");
      expect(res.status).toBe(200);

      const body = await jsonBody<ExportResponse>(res);
      expect(body.documents).toHaveLength(3);

      const paths = body.documents.map((d) => d.path).sort();
      expect(paths).toEqual(["posts/post1", "users/alice", "users/bob"]);

      const alice = body.documents.find((d) => d.path === "users/alice");
      expect(alice?.data).toEqual({ name: "Alice", age: 30 });
      expect(alice?.createTime).toBeDefined();
      expect(alice?.updateTime).toBeDefined();
    });
  });

  describe("POST /import", () => {
    it("ドキュメントをインポートできる", async () => {
      const res = await request(app, "POST", "/import", {
        documents: [
          {
            path: "users/alice",
            data: { name: "Alice" },
            createTime: "2026-01-01T00:00:00Z",
            updateTime: "2026-01-01T00:00:00Z",
          },
          {
            path: "users/bob",
            data: { name: "Bob" },
            createTime: "2026-01-01T00:00:00Z",
            updateTime: "2026-01-01T00:00:00Z",
          },
        ],
      });
      expect(res.status).toBe(200);

      const body = await jsonBody<ImportResponse>(res);
      expect(body.imported).toBe(2);

      const getRes = await request(app, "GET", "/docs/users/alice");
      const doc = await jsonBody(getRes);
      expect(doc.exists).toBe(true);
      expect(doc.data).toEqual({ name: "Alice" });
    });

    it("clean: trueで既存データを削除してからインポートする", async () => {
      await request(app, "PUT", "/docs/users/charlie", {
        data: { name: "Charlie" },
      });

      const res = await request(app, "POST", "/import", {
        documents: [
          {
            path: "users/alice",
            data: { name: "Alice" },
            createTime: "2026-01-01T00:00:00Z",
            updateTime: "2026-01-01T00:00:00Z",
          },
        ],
        clean: true,
      });
      expect(res.status).toBe(200);

      const charlieRes = await request(app, "GET", "/docs/users/charlie");
      const charlie = await jsonBody(charlieRes);
      expect(charlie.exists).toBe(false);

      const aliceRes = await request(app, "GET", "/docs/users/alice");
      const alice = await jsonBody(aliceRes);
      expect(alice.exists).toBe(true);
    });

    it("エクスポートしたデータをそのままインポートできる（往復）", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", age: 30 },
      });
      await request(app, "PUT", "/docs/posts/post1", {
        data: { title: "Hello", tags: ["a", "b"] },
      });

      const exportRes = await request(app, "GET", "/export");
      const exported = await jsonBody<ExportResponse>(exportRes);

      // 新しいアプリで復元
      const newApp = createTestApp();
      const importRes = await request(newApp, "POST", "/import", {
        documents: exported.documents,
      });
      const importBody = await jsonBody<ImportResponse>(importRes);
      expect(importBody.imported).toBe(2);

      const aliceRes = await request(newApp, "GET", "/docs/users/alice");
      const alice = await jsonBody(aliceRes);
      expect(alice.data).toEqual({ name: "Alice", age: 30 });

      const postRes = await request(newApp, "GET", "/docs/posts/post1");
      const post = await jsonBody(postRes);
      expect(post.data).toEqual({ title: "Hello", tags: ["a", "b"] });
    });
  });
});
