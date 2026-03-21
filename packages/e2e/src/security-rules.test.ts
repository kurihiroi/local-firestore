import type { SecurityRules } from "@local-firestore/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

/**
 * Helper to make HTTP requests with auth headers directly
 */
async function fetchWithAuth(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  uid?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (uid) {
    headers.Authorization = `Bearer ${uid}`;
  }
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("E2E: Security rules", () => {
  describe("basic read/write rules", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        public: { read: true, write: true },
        private: { read: false, write: false },
        authOnly: { read: "request.auth != null", write: "request.auth != null" },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("T11.1: read:false should deny getDoc with 403", async () => {
      const res = await fetchWithAuth(ctx.port, "GET", "/docs/private/doc1");
      expect(res.status).toBe(403);
    });

    it("T11.2: write:false should deny setDoc with 403", async () => {
      const res = await fetchWithAuth(ctx.port, "PUT", "/docs/private/doc1", {
        data: { value: 1 },
      });
      expect(res.status).toBe(403);
    });

    it("T11.3: auth-based rules should allow/deny based on authentication", async () => {
      // Without auth: should be denied
      const denied = await fetchWithAuth(ctx.port, "PUT", "/docs/authOnly/doc1", {
        data: { value: 1 },
      });
      expect(denied.status).toBe(403);

      // With auth: should be allowed
      const allowed = await fetchWithAuth(
        ctx.port,
        "PUT",
        "/docs/authOnly/doc1",
        {
          data: { value: 1 },
        },
        "user123",
      );
      expect(allowed.status).toBe(200);

      // Authenticated read should work
      const readOk = await fetchWithAuth(
        ctx.port,
        "GET",
        "/docs/authOnly/doc1",
        undefined,
        "user123",
      );
      expect(readOk.status).toBe(200);

      // Unauthenticated read should fail
      const readFail = await fetchWithAuth(ctx.port, "GET", "/docs/authOnly/doc1");
      expect(readFail.status).toBe(403);
    });
  });

  describe("wildcard collection rules", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        allowed: { read: true, write: true },
        "{collection}": { read: "request.auth != null", write: false },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("T11.3b: wildcard collection should match and exact match should take priority", async () => {
      // Exact match: allowed collection is public
      const exactWrite = await fetchWithAuth(ctx.port, "PUT", "/docs/allowed/doc1", {
        data: { value: 1 },
      });
      expect(exactWrite.status).toBe(200);

      // Wildcard match: other collections require auth for read, deny write
      const wildcardReadNoAuth = await fetchWithAuth(ctx.port, "GET", "/docs/other/doc1");
      expect(wildcardReadNoAuth.status).toBe(403);

      const wildcardReadAuth = await fetchWithAuth(
        ctx.port,
        "GET",
        "/docs/other/doc1",
        undefined,
        "user1",
      );
      expect(wildcardReadAuth.status).toBe(200);

      const wildcardWrite = await fetchWithAuth(
        ctx.port,
        "PUT",
        "/docs/other/doc1",
        {
          data: { value: 1 },
        },
        "user1",
      );
      expect(wildcardWrite.status).toBe(403);
    });
  });

  describe("separate operation rules", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        restricted: {
          read: true,
          create: "request.auth != null",
          update: "request.auth != null",
          delete: false,
        },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("T11.8: separate create/update/delete rules should apply independently", async () => {
      // Read is always allowed
      const readRes = await fetchWithAuth(ctx.port, "GET", "/docs/restricted/doc1");
      expect(readRes.status).toBe(200);

      // Create (PUT) without auth should fail
      const createNoAuth = await fetchWithAuth(ctx.port, "PUT", "/docs/restricted/doc1", {
        data: { value: 1 },
      });
      expect(createNoAuth.status).toBe(403);

      // Create with auth should succeed
      const createOk = await fetchWithAuth(
        ctx.port,
        "PUT",
        "/docs/restricted/doc1",
        {
          data: { value: 1 },
        },
        "user1",
      );
      expect(createOk.status).toBe(200);

      // Update (PATCH) with auth should succeed
      const updateOk = await fetchWithAuth(
        ctx.port,
        "PATCH",
        "/docs/restricted/doc1",
        {
          data: { value: 2 },
        },
        "user1",
      );
      expect(updateOk.status).toBe(200);

      // Delete should always fail
      const deleteRes = await fetchWithAuth(
        ctx.port,
        "DELETE",
        "/docs/restricted/doc1",
        undefined,
        "user1",
      );
      expect(deleteRes.status).toBe(403);
    });
  });

  describe("request.resource.data validation rules", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        validated: {
          read: true,
          create: "request.resource.data.name is string && request.resource.data.name.size() > 0",
        },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("T11.4: request.resource.data should validate write data", async () => {
      // Valid: name is a non-empty string
      const valid = await fetchWithAuth(ctx.port, "PUT", "/docs/validated/doc1", {
        data: { name: "Valid" },
      });
      expect(valid.status).toBe(200);

      // Invalid: name is empty string
      const invalid = await fetchWithAuth(ctx.port, "PUT", "/docs/validated/doc2", {
        data: { name: "" },
      });
      expect(invalid.status).toBe(403);
    });
  });

  describe("resource.data existing document rules", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        lockable: {
          read: true,
          create: true,
          update: "resource.data.locked != true",
          delete: "resource.data.locked != true",
        },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("T11.5: resource.data should reference existing document data", async () => {
      // Create an unlocked document
      await fetchWithAuth(ctx.port, "PUT", "/docs/lockable/unlocked", {
        data: { name: "Unlocked", locked: false },
      });

      // Update should succeed (locked != true)
      const updateOk = await fetchWithAuth(ctx.port, "PATCH", "/docs/lockable/unlocked", {
        data: { name: "Updated" },
      });
      expect(updateOk.status).toBe(200);

      // Create a locked document
      await fetchWithAuth(ctx.port, "PUT", "/docs/lockable/locked", {
        data: { name: "Locked", locked: true },
      });

      // Update should fail (locked == true)
      const updateFail = await fetchWithAuth(ctx.port, "PATCH", "/docs/lockable/locked", {
        data: { name: "Hacked" },
      });
      expect(updateFail.status).toBe(403);

      // Delete locked should fail
      const deleteFail = await fetchWithAuth(ctx.port, "DELETE", "/docs/lockable/locked");
      expect(deleteFail.status).toBe(403);

      // Delete unlocked should succeed
      const deleteOk = await fetchWithAuth(ctx.port, "DELETE", "/docs/lockable/unlocked");
      expect(deleteOk.status).toBe(200);
    });
  });

  describe("token claims rules", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        adminArea: {
          read: "request.auth != null && request.auth.token.admin == true",
          write: "request.auth != null && request.auth.token.admin == true",
        },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("T11.7: token claims should be accessible in rules", async () => {
      // LocalAuthProvider format: Bearer uid:{"admin":true}
      const adminHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: 'Bearer admin1:{"admin":true}',
      };

      // Admin can write
      const writeRes = await fetch(`http://localhost:${ctx.port}/docs/adminArea/doc1`, {
        method: "PUT",
        headers: adminHeaders,
        body: JSON.stringify({ data: { secret: "value" } }),
      });
      expect(writeRes.status).toBe(200);

      // Admin can read
      const readRes = await fetch(`http://localhost:${ctx.port}/docs/adminArea/doc1`, {
        method: "GET",
        headers: adminHeaders,
      });
      expect(readRes.status).toBe(200);

      // Non-admin user cannot read
      const userRead = await fetchWithAuth(
        ctx.port,
        "GET",
        "/docs/adminArea/doc1",
        undefined,
        "user1",
      );
      expect(userRead.status).toBe(403);

      // Unauthenticated cannot read
      const noAuth = await fetchWithAuth(ctx.port, "GET", "/docs/adminArea/doc1");
      expect(noAuth.status).toBe(403);
    });
  });
});
