import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDatabase } from "../storage/sqlite.js";
import { LocalAuthProvider } from "./auth-provider.js";
import { createAuthRequiredRules, SecurityRulesEngine } from "./rules-engine.js";

function createTestAppWithRules(engine: SecurityRulesEngine) {
  const db = createDatabase(":memory:");
  return createApp(db, undefined, { securityRules: engine, authProvider: new LocalAuthProvider() });
}

async function request(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  options?: { body?: unknown; headers?: Record<string, string> },
) {
  const init: RequestInit = {
    method,
    headers: { ...options?.headers },
  };
  if (options?.body) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  return app.request(path, init);
}

describe("securityRulesMiddleware", () => {
  describe("with auth required rules", () => {
    const engine = new SecurityRulesEngine(createAuthRequiredRules());

    it("should deny unauthenticated GET /docs/users/user1", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "GET", "/docs/users/user1");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("permission-denied");
    });

    it("should allow authenticated GET /docs/users/user1", async () => {
      const app = createTestAppWithRules(engine);
      // まずドキュメントを作成（認証付き）
      await request(app, "PUT", "/docs/users/user1", {
        body: { data: { name: "Alice" } },
        headers: { Authorization: "Bearer user1" },
      });
      const res = await request(app, "GET", "/docs/users/user1", {
        headers: { Authorization: "Bearer user1" },
      });
      expect(res.status).toBe(200);
    });

    it("should deny unauthenticated PUT /docs/users/user1", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "PUT", "/docs/users/user1", {
        body: { data: { name: "Alice" } },
      });
      expect(res.status).toBe(403);
    });

    it("should allow authenticated PUT /docs/users/user1", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "PUT", "/docs/users/user1", {
        body: { data: { name: "Alice" } },
        headers: { Authorization: "Bearer user1" },
      });
      expect(res.status).toBe(200);
    });

    it("should deny unauthenticated DELETE /docs/users/user1", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "DELETE", "/docs/users/user1");
      expect(res.status).toBe(403);
    });
  });

  describe("with custom rules", () => {
    it("should apply collection-specific rules", async () => {
      const engine = new SecurityRulesEngine({
        rules: {
          public: { read: true, write: true },
          private: { read: "auth != null", write: "auth != null" },
        },
      });
      const app = createTestAppWithRules(engine);

      // publicコレクションは認証不要
      const pubRes = await request(app, "PUT", "/docs/public/doc1", {
        body: { data: { text: "hello" } },
      });
      expect(pubRes.status).toBe(200);

      // privateコレクションは認証必要
      const privRes = await request(app, "PUT", "/docs/private/doc1", {
        body: { data: { text: "secret" } },
      });
      expect(privRes.status).toBe(403);

      // privateコレクションに認証付きでアクセス
      const authRes = await request(app, "PUT", "/docs/private/doc1", {
        body: { data: { text: "secret" } },
        headers: { Authorization: "Bearer user1" },
      });
      expect(authRes.status).toBe(200);
    });
  });

  describe("request.resource.data validation", () => {
    it("should pass requestData to rule evaluation", async () => {
      const engine = new SecurityRulesEngine({
        rules: {
          validated: {
            read: true,
            create: "request.resource.data.name is string && request.resource.data.name.size() > 0",
          },
        },
      });
      const app = createTestAppWithRules(engine);

      // 有効なデータ: nameが非空文字列
      const validRes = await request(app, "PUT", "/docs/validated/doc1", {
        body: { data: { name: "Valid" } },
      });
      expect(validRes.status).toBe(200);

      // 無効なデータ: nameが空文字列
      const invalidRes = await request(app, "PUT", "/docs/validated/doc2", {
        body: { data: { name: "" } },
      });
      expect(invalidRes.status).toBe(403);
    });
  });

  describe("resource.data (existing document) validation", () => {
    it("should pass existingData to rule evaluation for update", async () => {
      const engine = new SecurityRulesEngine({
        rules: {
          lockable: {
            read: true,
            create: true,
            update: "resource.data.locked != true",
            delete: "resource.data.locked != true",
          },
        },
      });
      const app = createTestAppWithRules(engine);

      // ロックされていないドキュメントを作成
      await request(app, "PUT", "/docs/lockable/unlocked", {
        body: { data: { name: "Unlocked", locked: false } },
      });
      // 更新は成功するべき
      const updateOk = await request(app, "PATCH", "/docs/lockable/unlocked", {
        body: { data: { name: "Updated" } },
      });
      expect(updateOk.status).toBe(200);

      // ロックされたドキュメントを作成
      await request(app, "PUT", "/docs/lockable/locked", {
        body: { data: { name: "Locked", locked: true } },
      });
      // 更新は失敗するべき
      const updateFail = await request(app, "PATCH", "/docs/lockable/locked", {
        body: { data: { name: "Hacked" } },
      });
      expect(updateFail.status).toBe(403);

      // ロックされたドキュメントの削除も失敗するべき
      const deleteFail = await request(app, "DELETE", "/docs/lockable/locked");
      expect(deleteFail.status).toBe(403);

      // ロックされていないドキュメントの削除は成功するべき
      const deleteOk = await request(app, "DELETE", "/docs/lockable/unlocked");
      expect(deleteOk.status).toBe(200);
    });
  });

  describe("query / aggregate rules (list operation)", () => {
    const engine = new SecurityRulesEngine(createAuthRequiredRules());

    it("should deny unauthenticated POST /query", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "POST", "/query", {
        body: { collectionPath: "users", constraints: [] },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("permission-denied");
    });

    it("should allow authenticated POST /query", async () => {
      const app = createTestAppWithRules(engine);
      await request(app, "PUT", "/docs/users/user1", {
        body: { data: { name: "Alice" } },
        headers: { Authorization: "Bearer user1" },
      });
      const res = await request(app, "POST", "/query", {
        body: { collectionPath: "users", constraints: [] },
        headers: { Authorization: "Bearer user1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.docs).toHaveLength(1);
    });

    it("should deny unauthenticated POST /aggregate", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "POST", "/aggregate", {
        body: {
          collectionPath: "users",
          constraints: [],
          aggregateSpec: { total: { aggregateType: "count" } },
        },
      });
      expect(res.status).toBe(403);
    });

    it("should allow authenticated POST /aggregate", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "POST", "/aggregate", {
        body: {
          collectionPath: "users",
          constraints: [],
          aggregateSpec: { total: { aggregateType: "count" } },
        },
        headers: { Authorization: "Bearer user1" },
      });
      expect(res.status).toBe(200);
    });

    it("should evaluate list rule (not read shortcut) when defined", async () => {
      const listOnlyEngine = new SecurityRulesEngine({
        rules: {
          items: { get: true, list: "request.auth != null", write: true },
        },
      });
      const app = createTestAppWithRules(listOnlyEngine);

      // get は許可されるが list（クエリ）は認証必須
      await request(app, "PUT", "/docs/items/item1", { body: { data: { v: 1 } } });
      const getRes = await request(app, "GET", "/docs/items/item1");
      expect(getRes.status).toBe(200);

      const queryDenied = await request(app, "POST", "/query", {
        body: { collectionPath: "items", constraints: [] },
      });
      expect(queryDenied.status).toBe(403);

      const queryAllowed = await request(app, "POST", "/query", {
        body: { collectionPath: "items", constraints: [] },
        headers: { Authorization: "Bearer user1" },
      });
      expect(queryAllowed.status).toBe(200);
    });
  });

  describe("per-document list evaluation (rules are not filters)", () => {
    const engine = new SecurityRulesEngine({
      rules: {
        posts: {
          get: true,
          list: "resource.data.visibility == 'public'",
          write: true,
        },
      },
    });

    async function seedPosts(app: ReturnType<typeof createApp>) {
      await request(app, "PUT", "/docs/posts/pub1", {
        body: { data: { visibility: "public", title: "A" } },
      });
      await request(app, "PUT", "/docs/posts/priv1", {
        body: { data: { visibility: "private", title: "B" } },
      });
    }

    it("should deny the whole query when results include a denied document", async () => {
      const app = createTestAppWithRules(engine);
      await seedPosts(app);

      // フィルタなしのクエリは private ドキュメントを含むため全体が拒否される
      const res = await request(app, "POST", "/query", {
        body: { collectionPath: "posts", constraints: [] },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("permission-denied");
    });

    it("should allow a query constrained to satisfying documents", async () => {
      const app = createTestAppWithRules(engine);
      await seedPosts(app);

      const res = await request(app, "POST", "/query", {
        body: {
          collectionPath: "posts",
          constraints: [{ type: "where", fieldPath: "visibility", op: "==", value: "public" }],
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].path).toBe("posts/pub1");
    });

    it("should apply per-document evaluation to /aggregate", async () => {
      const app = createTestAppWithRules(engine);
      await seedPosts(app);

      const deniedRes = await request(app, "POST", "/aggregate", {
        body: {
          collectionPath: "posts",
          constraints: [],
          aggregateSpec: { total: { aggregateType: "count" } },
        },
      });
      expect(deniedRes.status).toBe(403);

      const allowedRes = await request(app, "POST", "/aggregate", {
        body: {
          collectionPath: "posts",
          constraints: [{ type: "where", fieldPath: "visibility", op: "==", value: "public" }],
          aggregateSpec: { total: { aggregateType: "count" } },
        },
      });
      expect(allowedRes.status).toBe(200);
    });

    it("should deny empty-result queries when rule requires resource", async () => {
      const app = createTestAppWithRules(engine);
      // ドキュメントなし: コレクションレベルで1回評価され、resource == null で
      // 評価エラー → 拒否（本家同様）
      const res = await request(app, "POST", "/query", {
        body: { collectionPath: "posts", constraints: [] },
      });
      expect(res.status).toBe(403);
    });

    it("should bind request.query.limit for list rules", async () => {
      const limitEngine = new SecurityRulesEngine({
        rules: {
          limited: {
            get: true,
            write: true,
            list: "request.query.limit != null && request.query.limit <= 10",
          },
        },
      });
      const app = createTestAppWithRules(limitEngine);
      await request(app, "PUT", "/docs/limited/doc1", { body: { data: { v: 1 } } });

      const noLimit = await request(app, "POST", "/query", {
        body: { collectionPath: "limited", constraints: [] },
      });
      expect(noLimit.status).toBe(403);

      const withinLimit = await request(app, "POST", "/query", {
        body: { collectionPath: "limited", constraints: [{ type: "limit", limit: 5 }] },
      });
      expect(withinLimit.status).toBe(200);

      const overLimit = await request(app, "POST", "/query", {
        body: { collectionPath: "limited", constraints: [{ type: "limit", limit: 100 }] },
      });
      expect(overLimit.status).toBe(403);
    });

    it("should evaluate collection group queries against real document paths", async () => {
      const groupEngine = new SecurityRulesEngine({
        rules: {
          "{path=**}": {
            subcollections: {
              comments: { list: "resource.data.visibility == 'public'", get: true, write: true },
            },
          },
          posts: { read: true, write: true },
        },
      });
      const app = createTestAppWithRules(groupEngine);
      await request(app, "PUT", "/docs/posts/p1/comments/c1", {
        body: { data: { visibility: "public" } },
      });

      const allowed = await request(app, "POST", "/query", {
        body: { collectionPath: "comments", collectionGroup: true, constraints: [] },
      });
      expect(allowed.status).toBe(200);

      await request(app, "PUT", "/docs/posts/p2/comments/c2", {
        body: { data: { visibility: "private" } },
      });
      const denied = await request(app, "POST", "/query", {
        body: { collectionPath: "comments", collectionGroup: true, constraints: [] },
      });
      expect(denied.status).toBe(403);
    });
  });

  describe("batch rules", () => {
    const engine = new SecurityRulesEngine(createAuthRequiredRules());

    it("should deny unauthenticated POST /batch", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "POST", "/batch", {
        body: { operations: [{ type: "set", path: "users/user1", data: { name: "Alice" } }] },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("permission-denied");
      expect(body.message).toContain("users/user1");
    });

    it("should allow authenticated POST /batch", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "POST", "/batch", {
        body: {
          operations: [
            { type: "set", path: "users/user1", data: { name: "Alice" } },
            { type: "set", path: "users/user2", data: { name: "Bob" } },
          ],
        },
        headers: { Authorization: "Bearer user1" },
      });
      expect(res.status).toBe(200);
    });

    it("should deny batch when any operation is denied", async () => {
      const mixedEngine = new SecurityRulesEngine({
        rules: {
          open: { read: true, write: true },
          closed: { read: true, write: false },
        },
      });
      const app = createTestAppWithRules(mixedEngine);
      const res = await request(app, "POST", "/batch", {
        body: {
          operations: [
            { type: "set", path: "open/doc1", data: { v: 1 } },
            { type: "set", path: "closed/doc1", data: { v: 1 } },
          ],
        },
      });
      expect(res.status).toBe(403);

      // 拒否されたバッチは一切書き込まれない（原子性）
      const check = await request(app, "GET", "/docs/open/doc1");
      const checkBody = await check.json();
      expect(checkBody.exists).toBe(false);
    });

    it("should evaluate set as update when document exists", async () => {
      const engine2 = new SecurityRulesEngine({
        rules: {
          items: { read: true, create: true, update: false, delete: true },
        },
      });
      const app = createTestAppWithRules(engine2);

      // 新規作成（create ルール適用）は成功
      const createRes = await request(app, "POST", "/batch", {
        body: { operations: [{ type: "set", path: "items/item1", data: { v: 1 } }] },
      });
      expect(createRes.status).toBe(200);

      // 既存ドキュメントへの set（update ルール適用）は拒否
      const updateRes = await request(app, "POST", "/batch", {
        body: { operations: [{ type: "set", path: "items/item1", data: { v: 2 } }] },
      });
      expect(updateRes.status).toBe(403);
    });
  });

  describe("transaction rules", () => {
    const engine = new SecurityRulesEngine(createAuthRequiredRules());

    it("should deny unauthenticated POST /transaction/get", async () => {
      const app = createTestAppWithRules(engine);
      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await beginRes.json();

      const res = await request(app, "POST", "/transaction/get", {
        body: { transactionId, path: "users/user1" },
      });
      expect(res.status).toBe(403);
    });

    it("should allow authenticated POST /transaction/get", async () => {
      const app = createTestAppWithRules(engine);
      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await beginRes.json();

      const res = await request(app, "POST", "/transaction/get", {
        body: { transactionId, path: "users/user1" },
        headers: { Authorization: "Bearer user1" },
      });
      expect(res.status).toBe(200);
    });

    it("should deny unauthenticated POST /transaction/commit", async () => {
      const app = createTestAppWithRules(engine);
      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await beginRes.json();

      const res = await request(app, "POST", "/transaction/commit", {
        body: {
          transactionId,
          operations: [{ type: "set", path: "users/user1", data: { name: "Alice" } }],
        },
      });
      expect(res.status).toBe(403);
    });

    it("should allow authenticated POST /transaction/commit", async () => {
      const app = createTestAppWithRules(engine);
      const beginRes = await request(app, "POST", "/transaction/begin");
      const { transactionId } = await beginRes.json();

      const res = await request(app, "POST", "/transaction/commit", {
        body: {
          transactionId,
          operations: [{ type: "set", path: "users/user1", data: { name: "Alice" } }],
        },
        headers: { Authorization: "Bearer user1" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("non-docs routes should not be affected", () => {
    const engine = new SecurityRulesEngine(createAuthRequiredRules());

    it("should allow /health without auth", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "GET", "/health");
      expect(res.status).toBe(200);
    });

    it("should allow /metrics without auth", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "GET", "/metrics");
      expect(res.status).toBe(200);
    });

    it("should allow /admin without auth", async () => {
      const app = createTestAppWithRules(engine);
      const res = await request(app, "GET", "/admin");
      expect(res.status).toBe(200);
    });
  });
});
