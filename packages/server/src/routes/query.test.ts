import type { QueryResponse } from "@local-firestore/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("Query Routes", () => {
  let app: Hono;

  beforeEach(async () => {
    app = createTestApp();

    // テストデータ投入
    const users = [
      { path: "users/alice", data: { name: "Alice", age: 30, status: "active" } },
      { path: "users/bob", data: { name: "Bob", age: 25, status: "inactive" } },
      { path: "users/charlie", data: { name: "Charlie", age: 35, status: "active" } },
    ];
    for (const u of users) {
      await request(app, "PUT", `/docs/${u.path}`, { data: u.data });
    }
  });

  async function postQuery(body: unknown) {
    return request(app, "POST", "/query", body);
  }

  it("全ドキュメントを取得できる", async () => {
    const res = await postQuery({ collectionPath: "users", constraints: [] });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.docs).toHaveLength(3);
  });

  it("whereフィルタで絞り込みできる", async () => {
    const res = await postQuery({
      collectionPath: "users",
      constraints: [{ type: "where", fieldPath: "status", op: "==", value: "active" }],
    });
    const body = await jsonBody(res);
    expect(body.docs).toHaveLength(2);
  });

  it("orderBy + limit で取得できる", async () => {
    const res = await postQuery({
      collectionPath: "users",
      constraints: [
        { type: "orderBy", fieldPath: "age", direction: "asc" },
        { type: "limit", limit: 2 },
      ],
    });
    const body = await jsonBody<QueryResponse>(res);
    expect(body.docs).toHaveLength(2);
    expect((body.docs[0].data as Record<string, unknown>).name).toBe("Bob");
    expect((body.docs[1].data as Record<string, unknown>).name).toBe("Alice");
  });

  it("不正なコレクションパスで400を返す", async () => {
    const res = await postQuery({
      collectionPath: "users/alice",
      constraints: [],
    });
    expect(res.status).toBe(400);
  });
});
