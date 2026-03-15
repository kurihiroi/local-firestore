import type { GetDocumentResponse, TransactionBeginResponse } from "@local-firestore/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDatabase } from "../storage/sqlite.js";

describe("Batch & Transaction Routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    const db = createDatabase(":memory:");
    app = createApp(db);
  });

  async function request(method: string, path: string, body?: unknown) {
    const init: RequestInit = { method };
    if (body) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    return app.request(path, init);
  }

  async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
    return res.json() as Promise<T>;
  }

  describe("POST /batch", () => {
    it("複数操作をバッチ実行できる", async () => {
      const res = await request("POST", "/batch", {
        operations: [
          { type: "set", path: "users/alice", data: { name: "Alice" } },
          { type: "set", path: "users/bob", data: { name: "Bob" } },
        ],
      });
      expect(res.status).toBe(200);

      const alice = await request("GET", "/docs/users/alice");
      const aliceBody = await jsonBody<GetDocumentResponse>(alice);
      expect(aliceBody.exists).toBe(true);
      expect(aliceBody.data!.name).toBe("Alice");
    });
  });

  describe("Transaction flow", () => {
    it("begin → get → commit の基本フローが動く", async () => {
      // セットアップ
      await request("PUT", "/docs/users/alice", {
        data: { name: "Alice", balance: 100 },
      });

      // begin
      const beginRes = await request("POST", "/transaction/begin");
      const { transactionId } = await jsonBody<TransactionBeginResponse>(beginRes);
      expect(transactionId).toHaveLength(20);

      // get
      const getRes = await request("POST", "/transaction/get", {
        transactionId,
        path: "users/alice",
      });
      const getBody = await jsonBody<GetDocumentResponse>(getRes);
      expect(getBody.exists).toBe(true);
      expect((getBody.data as Record<string, unknown>).balance).toBe(100);

      // commit
      const commitRes = await request("POST", "/transaction/commit", {
        transactionId,
        operations: [{ type: "update", path: "users/alice", data: { balance: 80 } }],
      });
      expect(commitRes.status).toBe(200);

      // 確認
      const checkRes = await request("GET", "/docs/users/alice");
      const checkBody = await jsonBody<GetDocumentResponse>(checkRes);
      expect((checkBody.data as Record<string, unknown>).balance).toBe(80);
    });

    it("コンフリクト時に409を返す", async () => {
      await request("PUT", "/docs/users/alice", {
        data: { balance: 100 },
      });

      // トランザクション開始 & 読み取り
      const beginRes = await request("POST", "/transaction/begin");
      const { transactionId } = await jsonBody<TransactionBeginResponse>(beginRes);
      await request("POST", "/transaction/get", {
        transactionId,
        path: "users/alice",
      });

      // 外部から変更
      await request("PUT", "/docs/users/alice", {
        data: { balance: 50 },
      });

      // コミット → コンフリクト
      const commitRes = await request("POST", "/transaction/commit", {
        transactionId,
        operations: [{ type: "update", path: "users/alice", data: { balance: 80 } }],
      });
      expect(commitRes.status).toBe(409);
    });

    it("rollbackでトランザクションを破棄できる", async () => {
      const beginRes = await request("POST", "/transaction/begin");
      const { transactionId } = await jsonBody<TransactionBeginResponse>(beginRes);

      const rollbackRes = await request("POST", "/transaction/rollback", {
        transactionId,
      });
      expect(rollbackRes.status).toBe(200);

      // rollback後のgetは404
      const getRes = await request("POST", "/transaction/get", {
        transactionId,
        path: "users/alice",
      });
      expect(getRes.status).toBe(404);
    });
  });
});
