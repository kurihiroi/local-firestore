import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { DatabaseManager } from "../services/database-manager.js";
import { createDatabase } from "../storage/sqlite.js";
import { jsonBody, request } from "./test-helpers.js";

describe("マルチデータベースルーティング (/databases/:databaseId/*)", () => {
  let manager: DatabaseManager;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    manager = new DatabaseManager(":memory:");
    const db = createDatabase(":memory:");
    app = createApp(db, undefined, { databaseManager: manager });
  });

  afterEach(() => {
    manager.closeAll();
  });

  it("データベースごとにドキュメントが分離される", async () => {
    // db1 に書き込み
    const putRes = await request(app, "PUT", "/databases/db1/docs/users/alice", {
      data: { name: "Alice in db1" },
    });
    expect(putRes.status).toBe(200);

    // db1 からは取得できる
    const getDb1 = await request(app, "GET", "/databases/db1/docs/users/alice");
    const body1 = await jsonBody<{ exists: boolean; data: { name: string } }>(getDb1);
    expect(body1.exists).toBe(true);
    expect(body1.data.name).toBe("Alice in db1");

    // db2 とデフォルトデータベースには存在しない
    const getDb2 = await request(app, "GET", "/databases/db2/docs/users/alice");
    expect((await jsonBody<{ exists: boolean }>(getDb2)).exists).toBe(false);

    const getDefault = await request(app, "GET", "/docs/users/alice");
    expect((await jsonBody<{ exists: boolean }>(getDefault)).exists).toBe(false);
  });

  it("デフォルトデータベースへの書き込みは /databases/(default) からも見える", async () => {
    await request(app, "PUT", "/docs/users/bob", { data: { name: "Bob" } });

    const viaPrefix = await request(app, "GET", "/databases/(default)/docs/users/bob");
    const body = await jsonBody<{ exists: boolean; data: { name: string } }>(viaPrefix);
    expect(body.exists).toBe(true);
    expect(body.data.name).toBe("Bob");
  });

  it("データベースごとにクエリを実行できる", async () => {
    await request(app, "PUT", "/databases/db1/docs/items/a", { data: { price: 100 } });
    await request(app, "PUT", "/databases/db1/docs/items/b", { data: { price: 200 } });
    await request(app, "PUT", "/databases/db2/docs/items/c", { data: { price: 300 } });

    const res = await request(app, "POST", "/databases/db1/query", {
      collectionPath: "items",
      constraints: [],
    });
    const body = await jsonBody<{ docs: unknown[] }>(res);
    expect(body.docs).toHaveLength(2);
  });

  it("無効なデータベースIDは400", async () => {
    const res = await request(app, "GET", "/databases/Invalid_ID/docs/users/alice");
    expect(res.status).toBe(400);
    const body = await jsonBody<{ code: string }>(res);
    expect(body.code).toBe("invalid-argument");
  });

  it("databaseManager 未指定なら /databases/* は404", async () => {
    const db = createDatabase(":memory:");
    const singleApp = createApp(db);
    const res = await request(singleApp, "GET", "/databases/db1/docs/users/alice");
    expect(res.status).toBe(404);
  });
});
