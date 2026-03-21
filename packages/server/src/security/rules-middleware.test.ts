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
