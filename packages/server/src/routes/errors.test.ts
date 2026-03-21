import type { ErrorResponse } from "@local-firestore/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("エラーレスポンスのFirestoreErrorCode互換性", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  describe("invalid-argument エラー", () => {
    it("GET /docs で不正なドキュメントパス → code: invalid-argument", async () => {
      const res = await request(app, "GET", "/docs/users");
      expect(res.status).toBe(400);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("invalid-argument");
      expect(body.message).toBeDefined();
    });

    it("PUT /docs で不正なパス → code: invalid-argument", async () => {
      const res = await request(app, "PUT", "/docs/users", { data: {} });
      expect(res.status).toBe(400);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("invalid-argument");
    });

    it("POST /docs で不正なコレクションパス → code: invalid-argument", async () => {
      const res = await request(app, "POST", "/docs", {
        collectionPath: "users/alice",
        data: {},
      });
      expect(res.status).toBe(400);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("invalid-argument");
    });

    it("PATCH /docs で不正なパス → code: invalid-argument", async () => {
      const res = await request(app, "PATCH", "/docs/users", { data: {} });
      expect(res.status).toBe(400);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("invalid-argument");
    });

    it("DELETE /docs で不正なパス → code: invalid-argument", async () => {
      const res = await request(app, "DELETE", "/docs/users");
      expect(res.status).toBe(400);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("invalid-argument");
    });

    it("POST /query で不正なコレクションパス → code: invalid-argument", async () => {
      const res = await request(app, "POST", "/query", {
        collectionPath: "users/alice",
        constraints: [],
      });
      expect(res.status).toBe(400);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("invalid-argument");
    });

    it("POST /aggregate で空のaggregateSpec → code: invalid-argument", async () => {
      const res = await request(app, "POST", "/aggregate", {
        collectionPath: "users",
        constraints: [],
        aggregateSpec: {},
      });
      expect(res.status).toBe(400);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("invalid-argument");
    });
  });

  describe("not-found エラー", () => {
    it("PATCH /docs で存在しないドキュメント → code: not-found", async () => {
      const res = await request(app, "PATCH", "/docs/users/nobody", { data: { name: "test" } });
      expect(res.status).toBe(404);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("not-found");
      expect(body.message).toContain("not found");
    });

    it("存在しないトランザクションの取得 → code: not-found", async () => {
      const res = await request(app, "POST", "/transaction/get", {
        transactionId: "nonexistent",
        path: "users/alice",
      });
      expect(res.status).toBe(404);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("not-found");
    });

    it("存在しないトランザクションのコミット → code: not-found", async () => {
      const res = await request(app, "POST", "/transaction/commit", {
        transactionId: "nonexistent",
        operations: [],
      });
      expect(res.status).toBe(404);
      const body = await jsonBody<ErrorResponse>(res);
      expect(body.code).toBe("not-found");
    });
  });

  describe("aborted エラー", () => {
    it("トランザクションコンフリクト → code: aborted", async () => {
      // ドキュメントを作成
      await request(app, "PUT", "/docs/users/alice", { data: { balance: 100 } });

      // トランザクション開始
      const beginRes = await request(app, "POST", "/transaction/begin", {});
      const { transactionId } = await jsonBody<{ transactionId: string }>(beginRes);

      // トランザクション内で読み取り
      await request(app, "POST", "/transaction/get", {
        transactionId,
        path: "users/alice",
      });

      // トランザクション外で変更
      await request(app, "PUT", "/docs/users/alice", { data: { balance: 50 } });

      // コミット → コンフリクト
      const commitRes = await request(app, "POST", "/transaction/commit", {
        transactionId,
        operations: [{ type: "update", path: "users/alice", data: { balance: 80 } }],
      });
      expect(commitRes.status).toBe(409);
      const body = await jsonBody<ErrorResponse>(commitRes);
      expect(body.code).toBe("aborted");
    });
  });
});
