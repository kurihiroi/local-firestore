import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createDatabase } from "../storage/sqlite.js";
import { createAuthRequiredRules, SecurityRulesEngine } from "./rules-engine.js";

function createTestAppWithRules(engine: SecurityRulesEngine) {
  const db = createDatabase(":memory:");
  return createApp(db, undefined, { securityRules: engine });
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
