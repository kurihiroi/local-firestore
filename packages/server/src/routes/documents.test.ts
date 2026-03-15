import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("Document Routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  describe("GET /health", () => {
    it("ヘルスチェックが成功する", async () => {
      const res = await request(app, "GET", "/health");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ status: "ok" });
    });
  });

  describe("PUT /docs/:path - setDoc", () => {
    it("ドキュメントを作成できる", async () => {
      const res = await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", age: 30 },
      });
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ success: true });
    });

    it("不正なパスで400を返す", async () => {
      const res = await request(app, "PUT", "/docs/users", {
        data: { name: "Alice" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /docs/:path - getDoc", () => {
    it("存在するドキュメントを取得できる", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", age: 30 },
      });

      const res = await request(app, "GET", "/docs/users/alice");
      expect(res.status).toBe(200);

      const body = await jsonBody(res);
      expect(body.exists).toBe(true);
      expect(body.data).toEqual({ name: "Alice", age: 30 });
      expect(body.createTime).toBeDefined();
      expect(body.updateTime).toBeDefined();
    });

    it("存在しないドキュメントはexists=falseで返る", async () => {
      const res = await request(app, "GET", "/docs/users/nobody");
      expect(res.status).toBe(200);

      const body = await jsonBody(res);
      expect(body.exists).toBe(false);
      expect(body.data).toBeNull();
    });
  });

  describe("POST /docs - addDoc", () => {
    it("自動IDでドキュメントを追加できる", async () => {
      const res = await request(app, "POST", "/docs", {
        collectionPath: "users",
        data: { name: "Bob" },
      });
      expect(res.status).toBe(201);

      const body = await jsonBody(res);
      expect(body.documentId).toHaveLength(20);
      expect(body.path).toBe(`users/${body.documentId}`);
    });

    it("不正なコレクションパスで400を返す", async () => {
      const res = await request(app, "POST", "/docs", {
        collectionPath: "users/alice",
        data: { name: "Bob" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PATCH /docs/:path - updateDoc", () => {
    it("既存ドキュメントを部分更新できる", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", age: 30 },
      });

      const res = await request(app, "PATCH", "/docs/users/alice", {
        data: { age: 31 },
      });
      expect(res.status).toBe(200);

      const getRes = await request(app, "GET", "/docs/users/alice");
      const body = await jsonBody(getRes);
      expect(body.data).toEqual({ name: "Alice", age: 31 });
    });

    it("存在しないドキュメントの更新は404を返す", async () => {
      const res = await request(app, "PATCH", "/docs/users/nobody", {
        data: { name: "test" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /docs/:path - deleteDoc", () => {
    it("ドキュメントを削除できる", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice" },
      });

      const res = await request(app, "DELETE", "/docs/users/alice");
      expect(res.status).toBe(200);

      const getRes = await request(app, "GET", "/docs/users/alice");
      const body = await jsonBody(getRes);
      expect(body.exists).toBe(false);
    });
  });

  describe("サブコレクション", () => {
    it("サブコレクションのドキュメントをCRUDできる", async () => {
      await request(app, "PUT", "/docs/users/alice/posts/post1", {
        data: { title: "Hello World" },
      });

      const getRes = await request(app, "GET", "/docs/users/alice/posts/post1");
      const body = await jsonBody(getRes);
      expect(body.exists).toBe(true);
      expect(body.data).toEqual({ title: "Hello World" });
    });
  });
});
