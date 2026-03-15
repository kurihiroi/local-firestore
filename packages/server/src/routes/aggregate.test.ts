import type { AggregateResponse } from "@local-firestore/shared";
import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("Aggregate Routes", () => {
  let app: Hono;

  beforeEach(async () => {
    app = createTestApp();

    // テストデータ投入
    const users = [
      { path: "users/alice", data: { name: "Alice", age: 30, status: "active", score: 85 } },
      { path: "users/bob", data: { name: "Bob", age: 25, status: "inactive", score: 70 } },
      { path: "users/charlie", data: { name: "Charlie", age: 35, status: "active", score: 95 } },
    ];
    for (const u of users) {
      await request(app, "PUT", `/docs/${u.path}`, { data: u.data });
    }
  });

  async function postAggregate(body: unknown) {
    return request(app, "POST", "/aggregate", body);
  }

  it("countで全ドキュメント数を取得できる", async () => {
    const res = await postAggregate({
      collectionPath: "users",
      constraints: [],
      aggregateSpec: { count: { aggregateType: "count" } },
    });
    expect(res.status).toBe(200);
    const body = await jsonBody<AggregateResponse>(res);
    expect(body.data.count).toBe(3);
  });

  it("where条件付きでcountできる", async () => {
    const res = await postAggregate({
      collectionPath: "users",
      constraints: [{ type: "where", fieldPath: "status", op: "==", value: "active" }],
      aggregateSpec: { count: { aggregateType: "count" } },
    });
    const body = await jsonBody<AggregateResponse>(res);
    expect(body.data.count).toBe(2);
  });

  it("sumでフィールドの合計を取得できる", async () => {
    const res = await postAggregate({
      collectionPath: "users",
      constraints: [],
      aggregateSpec: { totalAge: { aggregateType: "sum", fieldPath: "age" } },
    });
    const body = await jsonBody<AggregateResponse>(res);
    expect(body.data.totalAge).toBe(90); // 30 + 25 + 35
  });

  it("avgでフィールドの平均を取得できる", async () => {
    const res = await postAggregate({
      collectionPath: "users",
      constraints: [],
      aggregateSpec: { avgScore: { aggregateType: "avg", fieldPath: "score" } },
    });
    const body = await jsonBody<AggregateResponse>(res);
    // (85 + 70 + 95) / 3 ≈ 83.33
    expect(body.data.avgScore).toBeCloseTo(83.33, 1);
  });

  it("複数の集計を同時に実行できる", async () => {
    const res = await postAggregate({
      collectionPath: "users",
      constraints: [],
      aggregateSpec: {
        count: { aggregateType: "count" },
        totalAge: { aggregateType: "sum", fieldPath: "age" },
        avgAge: { aggregateType: "avg", fieldPath: "age" },
      },
    });
    const body = await jsonBody<AggregateResponse>(res);
    expect(body.data.count).toBe(3);
    expect(body.data.totalAge).toBe(90);
    expect(body.data.avgAge).toBe(30);
  });

  it("空のコレクションでcountが0を返す", async () => {
    const res = await postAggregate({
      collectionPath: "empty",
      constraints: [],
      aggregateSpec: { count: { aggregateType: "count" } },
    });
    const body = await jsonBody<AggregateResponse>(res);
    expect(body.data.count).toBe(0);
  });

  it("空のコレクションでsumが0を返す", async () => {
    const res = await postAggregate({
      collectionPath: "empty",
      constraints: [],
      aggregateSpec: { total: { aggregateType: "sum", fieldPath: "age" } },
    });
    const body = await jsonBody<AggregateResponse>(res);
    expect(body.data.total).toBe(0);
  });

  it("空のコレクションでavgがnullを返す", async () => {
    const res = await postAggregate({
      collectionPath: "empty",
      constraints: [],
      aggregateSpec: { avg: { aggregateType: "avg", fieldPath: "age" } },
    });
    const body = await jsonBody<AggregateResponse>(res);
    expect(body.data.avg).toBeNull();
  });

  it("不正なコレクションパスで400を返す", async () => {
    const res = await postAggregate({
      collectionPath: "users/alice",
      constraints: [],
      aggregateSpec: { count: { aggregateType: "count" } },
    });
    expect(res.status).toBe(400);
  });

  it("空のaggregateSpecで400を返す", async () => {
    const res = await postAggregate({
      collectionPath: "users",
      constraints: [],
      aggregateSpec: {},
    });
    expect(res.status).toBe(400);
  });

  it("collectionGroupでcount集計できる", async () => {
    // サブコレクションにドキュメントを追加
    await request(app, "PUT", "/docs/teams/team1/users/dave", {
      data: { name: "Dave", age: 28 },
    });

    const res = await postAggregate({
      collectionPath: "users",
      collectionGroup: true,
      constraints: [],
      aggregateSpec: { count: { aggregateType: "count" } },
    });
    const body = await jsonBody<AggregateResponse>(res);
    // トップレベル3 + サブコレクション1 = 4
    expect(body.data.count).toBe(4);
  });
});
