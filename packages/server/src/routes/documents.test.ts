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
      const body = await jsonBody<{ status: string; database: string; uptime: number }>(res);
      expect(body.status).toBe("ok");
      expect(body.database).toBe("ok");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("PUT /docs/:path - setDoc", () => {
    it("ドキュメントを作成できる", async () => {
      const res = await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", age: 30 },
      });
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toMatchObject({ success: true, path: "users/alice" });
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

  describe("PUT /docs/:path with merge - setDoc with merge", () => {
    it("merge: trueで既存フィールドを保持したまま新しいフィールドを追加できる", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", age: 30, city: "Tokyo" },
      });

      const res = await request(app, "PUT", "/docs/users/alice", {
        data: { age: 31, email: "alice@example.com" },
        options: { merge: true },
      });
      expect(res.status).toBe(200);

      const getRes = await request(app, "GET", "/docs/users/alice");
      const body = await jsonBody(getRes);
      expect(body.data).toEqual({
        name: "Alice",
        age: 31,
        city: "Tokyo",
        email: "alice@example.com",
      });
    });

    it("mergeFieldsで指定したフィールドのみ更新される", async () => {
      await request(app, "PUT", "/docs/users/bob", {
        data: { name: "Bob", age: 25, city: "Osaka" },
      });

      const res = await request(app, "PUT", "/docs/users/bob", {
        data: { age: 26, city: "Kyoto", email: "bob@example.com" },
        options: { mergeFields: ["age"] },
      });
      expect(res.status).toBe(200);

      const getRes = await request(app, "GET", "/docs/users/bob");
      const body = await jsonBody(getRes);
      expect(body.data).toEqual({ name: "Bob", age: 26, city: "Osaka" });
    });

    it("存在しないドキュメントにmerge: trueでsetすると新規作成される", async () => {
      const res = await request(app, "PUT", "/docs/users/charlie", {
        data: { name: "Charlie" },
        options: { merge: true },
      });
      expect(res.status).toBe(200);

      const getRes = await request(app, "GET", "/docs/users/charlie");
      const body = await jsonBody(getRes);
      expect(body.exists).toBe(true);
      expect(body.data).toEqual({ name: "Charlie" });
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

  describe("書き込みレスポンスの WriteResult（4c）", () => {
    const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

    it("PUT /docs は path / createTime / updateTime を返す", async () => {
      const res = await request(app, "PUT", "/docs/users/w1", { data: { v: 1 } });
      const body = await jsonBody<{
        success: boolean;
        path: string;
        createTime: string;
        updateTime: string;
      }>(res);
      expect(body.success).toBe(true);
      expect(body.path).toBe("users/w1");
      expect(body.createTime).toMatch(MICRO_ISO);
      expect(body.updateTime).toMatch(MICRO_ISO);
    });

    it("PATCH /docs は更新後の updateTime を返す", async () => {
      const createRes = await request(app, "PUT", "/docs/users/w2", { data: { v: 1 } });
      const created = await jsonBody<{ updateTime: string }>(createRes);

      const res = await request(app, "PATCH", "/docs/users/w2", { data: { v: 2 } });
      const body = await jsonBody<{ path: string; updateTime: string }>(res);
      expect(body.path).toBe("users/w2");
      expect(body.updateTime >= created.updateTime).toBe(true);
    });

    it("POST /docs（addDoc）は createTime / updateTime を返す", async () => {
      const res = await request(app, "POST", "/docs", {
        collectionPath: "users",
        data: { v: 1 },
      });
      const body = await jsonBody<{ createTime: string; updateTime: string }>(res);
      expect(body.createTime).toMatch(MICRO_ISO);
      expect(body.updateTime).toBe(body.createTime);
    });
  });
});
