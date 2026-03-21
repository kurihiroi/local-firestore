import { describe, expect, it } from "vitest";
import { createTestApp, jsonBody, request } from "./test-helpers.js";

describe("Admin UI", () => {
  describe("GET /admin", () => {
    it("should return the admin HTML page", async () => {
      const app = createTestApp();
      const res = await app.request("/admin");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const body = await res.text();
      expect(body).toContain("Local Firestore Admin");
      expect(body).toContain("loadCollections");
    });
  });

  describe("GET /admin/api/collections", () => {
    it("should return empty collections when no documents exist", async () => {
      const app = createTestApp();
      const res = await request(app, "GET", "/admin/api/collections");
      const body = await jsonBody<{ collections: string[]; totalDocuments: number }>(res);
      expect(res.status).toBe(200);
      expect(body.collections).toEqual([]);
      expect(body.totalDocuments).toBe(0);
    });

    it("should return collections with documents", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/user1", { data: { name: "Alice" } });
      await request(app, "PUT", "/docs/users/user2", { data: { name: "Bob" } });
      await request(app, "PUT", "/docs/posts/post1", { data: { title: "Hello" } });

      const res = await request(app, "GET", "/admin/api/collections");
      const body = await jsonBody<{ collections: string[]; totalDocuments: number }>(res);
      expect(body.collections).toEqual(["posts", "users"]);
      expect(body.totalDocuments).toBe(3);
    });
  });

  describe("GET /admin/api/documents", () => {
    it("should return 400 without collection parameter", async () => {
      const app = createTestApp();
      const res = await request(app, "GET", "/admin/api/documents");
      expect(res.status).toBe(400);
    });

    it("should return documents in a collection", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/user1", { data: { name: "Alice" } });
      await request(app, "PUT", "/docs/users/user2", { data: { name: "Bob" } });

      const res = await request(app, "GET", "/admin/api/documents?collection=users");
      const body = await jsonBody<{
        documents: Array<{ documentId: string; data: Record<string, unknown> }>;
      }>(res);
      expect(res.status).toBe(200);
      expect(body.documents).toHaveLength(2);
      expect(body.documents.map((d) => d.documentId).sort()).toEqual(["user1", "user2"]);
    });
  });

  describe("GET /admin/api/document", () => {
    it("should return 400 without path parameter", async () => {
      const app = createTestApp();
      const res = await request(app, "GET", "/admin/api/document");
      expect(res.status).toBe(400);
    });

    it("should return 404 for non-existent document", async () => {
      const app = createTestApp();
      const res = await request(app, "GET", "/admin/api/document?path=users/nonexistent");
      expect(res.status).toBe(404);
    });

    it("should return document data", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/user1", { data: { name: "Alice", age: 30 } });

      const res = await request(app, "GET", "/admin/api/document?path=users/user1");
      const body = await jsonBody<{ path: string; data: Record<string, unknown>; version: number }>(
        res,
      );
      expect(res.status).toBe(200);
      expect(body.path).toBe("users/user1");
      expect(body.data).toEqual({ name: "Alice", age: 30 });
      expect(body.version).toBe(1);
    });
  });

  describe("PUT /admin/api/document", () => {
    it("should return 400 without path parameter", async () => {
      const app = createTestApp();
      const res = await request(app, "PUT", "/admin/api/document", { data: {} });
      expect(res.status).toBe(400);
    });

    it("should return 404 for non-existent document", async () => {
      const app = createTestApp();
      const res = await request(app, "PUT", "/admin/api/document?path=users/nonexistent", {
        data: { name: "Test" },
      });
      expect(res.status).toBe(404);
    });

    it("should update document data", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/user1", { data: { name: "Alice" } });

      const res = await request(app, "PUT", "/admin/api/document?path=users/user1", {
        data: { name: "Alice Updated", age: 31 },
      });
      expect(res.status).toBe(200);

      const getRes = await request(app, "GET", "/admin/api/document?path=users/user1");
      const body = await jsonBody<{ data: Record<string, unknown>; version: number }>(getRes);
      expect(body.data).toEqual({ name: "Alice Updated", age: 31 });
      expect(body.version).toBe(2);
    });
  });

  describe("DELETE /admin/api/document", () => {
    it("should return 400 without path parameter", async () => {
      const app = createTestApp();
      const res = await request(app, "DELETE", "/admin/api/document");
      expect(res.status).toBe(400);
    });

    it("should return 404 for non-existent document", async () => {
      const app = createTestApp();
      const res = await request(app, "DELETE", "/admin/api/document?path=users/nonexistent");
      expect(res.status).toBe(404);
    });

    it("should delete a document", async () => {
      const app = createTestApp();
      await request(app, "PUT", "/docs/users/user1", { data: { name: "Alice" } });

      const res = await request(app, "DELETE", "/admin/api/document?path=users/user1");
      expect(res.status).toBe(200);

      const getRes = await request(app, "GET", "/admin/api/document?path=users/user1");
      expect(getRes.status).toBe(404);
    });
  });
});
