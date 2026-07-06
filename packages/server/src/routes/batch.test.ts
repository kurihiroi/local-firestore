import type { GetDocumentResponse, TransactionBeginResponse } from "@local-firestore/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("Batch & Transaction Routes", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  describe("POST /batch", () => {
    it("複数操作をバッチ実行できる", async () => {
      const res = await request(app, "POST", "/batch", {
        operations: [
          { type: "set", path: "users/alice", data: { name: "Alice" } },
          { type: "set", path: "users/bob", data: { name: "Bob" } },
        ],
      });
      expect(res.status).toBe(200);

      const alice = await request(app, "GET", "/docs/users/alice");
      const aliceBody = await jsonBody<GetDocumentResponse>(alice);
      expect(aliceBody.exists).toBe(true);
      expect(aliceBody.data!.name).toBe("Alice");
    });

    it("500 オペレーション超のバッチは invalid-argument で拒否される", async () => {
      const operations = Array.from({ length: 501 }, (_, i) => ({
        type: "set",
        path: `users/u${i}`,
        data: { i },
      }));
      const res = await request(app, "POST", "/batch", { operations });
      expect(res.status).toBe(400);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe("invalid-argument");

      // 拒否されたバッチは一切書き込まれない
      const check = await request(app, "GET", "/docs/users/u0");
      const checkBody = await jsonBody<GetDocumentResponse>(check);
      expect(checkBody.exists).toBe(false);
    });

    it("バッチ内のドキュメントがリミット違反なら invalid-argument になる", async () => {
      const res = await request(app, "POST", "/batch", {
        operations: [{ type: "set", path: "users/big", data: { v: "x".repeat(1_048_576) } }],
      });
      expect(res.status).toBe(400);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe("invalid-argument");
    });
  });

  describe("POST /transaction/commit のリミット", () => {
    it("500 オペレーション超のコミットは invalid-argument で拒否される", async () => {
      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await jsonBody<TransactionBeginResponse>(beginRes);

      const operations = Array.from({ length: 501 }, (_, i) => ({
        type: "set",
        path: `users/u${i}`,
        data: { i },
      }));
      const res = await request(app, "POST", "/transaction/commit", {
        transactionId,
        operations,
      });
      expect(res.status).toBe(400);
      const body = await jsonBody<{ code: string }>(res);
      expect(body.code).toBe("invalid-argument");
    });
  });

  describe("Transaction flow", () => {
    it("begin → get → commit の基本フローが動く", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { name: "Alice", balance: 100 },
      });

      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await jsonBody<TransactionBeginResponse>(beginRes);
      expect(transactionId).toHaveLength(20);

      const getRes = await request(app, "POST", "/transaction/get", {
        transactionId,
        path: "users/alice",
      });
      const getBody = await jsonBody<GetDocumentResponse>(getRes);
      expect(getBody.exists).toBe(true);
      expect((getBody.data as Record<string, unknown>).balance).toBe(100);

      const commitRes = await request(app, "POST", "/transaction/commit", {
        transactionId,
        operations: [{ type: "update", path: "users/alice", data: { balance: 80 } }],
      });
      expect(commitRes.status).toBe(200);

      const checkRes = await request(app, "GET", "/docs/users/alice");
      const checkBody = await jsonBody<GetDocumentResponse>(checkRes);
      expect((checkBody.data as Record<string, unknown>).balance).toBe(80);
    });

    it("コンフリクト時に409を返す", async () => {
      await request(app, "PUT", "/docs/users/alice", {
        data: { balance: 100 },
      });

      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await jsonBody<TransactionBeginResponse>(beginRes);
      await request(app, "POST", "/transaction/get", {
        transactionId,
        path: "users/alice",
      });

      await request(app, "PUT", "/docs/users/alice", {
        data: { balance: 50 },
      });

      const commitRes = await request(app, "POST", "/transaction/commit", {
        transactionId,
        operations: [{ type: "update", path: "users/alice", data: { balance: 80 } }],
      });
      expect(commitRes.status).toBe(409);
    });

    it("rollbackでトランザクションを破棄できる", async () => {
      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await jsonBody<TransactionBeginResponse>(beginRes);

      const rollbackRes = await request(app, "POST", "/transaction/rollback", {
        transactionId,
      });
      expect(rollbackRes.status).toBe(200);

      const getRes = await request(app, "POST", "/transaction/get", {
        transactionId,
        path: "users/alice",
      });
      expect(getRes.status).toBe(404);
    });
  });
});
