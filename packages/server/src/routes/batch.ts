import type {
  BatchRequest,
  BatchResponse,
  ErrorResponse,
  GetDocumentResponse,
  TransactionBeginResponse,
  TransactionCommitRequest,
  TransactionCommitResponse,
  TransactionGetRequest,
  TransactionRollbackRequest,
} from "@local-firestore/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import type { TransactionService } from "../services/transaction.js";
import {
  TransactionConflictError,
  TransactionExpiredError,
  TransactionNotFoundError,
} from "../services/transaction.js";

export function createBatchRoutes(transactionService: TransactionService): Hono {
  const app = new Hono();

  // POST /batch - バッチ書き込み
  app.post("/batch", async (c) => {
    const body = await c.req.json<BatchRequest>();
    try {
      transactionService.executeBatch(body.operations);
      return c.json<BatchResponse>({ success: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // POST /transaction/begin - トランザクション開始
  app.post("/transaction/begin", (c) => {
    const transactionId = transactionService.begin();
    return c.json<TransactionBeginResponse>({ transactionId });
  });

  // POST /transaction/get - トランザクション内でドキュメント取得
  app.post("/transaction/get", async (c) => {
    const body = await c.req.json<TransactionGetRequest>();
    try {
      const doc = transactionService.getDocument(body.transactionId, body.path);
      const response: GetDocumentResponse = {
        exists: !!doc,
        path: body.path,
        data: doc?.data ?? null,
        createTime: doc?.createTime ?? null,
        updateTime: doc?.updateTime ?? null,
      };
      return c.json(response);
    } catch (e) {
      return handleError(c, e);
    }
  });

  // POST /transaction/commit - トランザクションコミット
  app.post("/transaction/commit", async (c) => {
    const body = await c.req.json<TransactionCommitRequest>();
    try {
      transactionService.commit(body.transactionId, body.operations);
      return c.json<TransactionCommitResponse>({ success: true });
    } catch (e) {
      return handleError(c, e);
    }
  });

  // POST /transaction/rollback - トランザクションロールバック
  app.post("/transaction/rollback", async (c) => {
    const body = await c.req.json<TransactionRollbackRequest>();
    transactionService.rollback(body.transactionId);
    return c.json({ success: true });
  });

  return app;
}

function handleError(c: Context, e: unknown) {
  if (e instanceof TransactionConflictError) {
    return c.json<ErrorResponse>({ code: e.code, message: e.message }, 409);
  }
  if (e instanceof TransactionNotFoundError) {
    return c.json<ErrorResponse>({ code: e.code, message: e.message }, 404);
  }
  if (e instanceof TransactionExpiredError) {
    return c.json<ErrorResponse>({ code: e.code, message: e.message }, 408);
  }
  throw e;
}
