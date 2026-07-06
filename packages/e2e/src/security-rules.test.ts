import {
  collection,
  doc,
  type FirestoreError,
  getFirestore,
  onSnapshot,
  setDoc,
  Timestamp,
  terminate,
} from "@local-firestore/client";
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

  describe("query / batch / transaction rules (E2E)", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        authOnly: { read: "request.auth != null", write: "request.auth != null" },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
      await fetchWithAuth(ctx.port, "PUT", "/docs/authOnly/doc1", { data: { value: 1 } }, "user1");
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("should enforce list rule on POST /query", async () => {
      const denied = await fetchWithAuth(ctx.port, "POST", "/query", {
        collectionPath: "authOnly",
        constraints: [],
      });
      expect(denied.status).toBe(403);

      const allowed = await fetchWithAuth(
        ctx.port,
        "POST",
        "/query",
        { collectionPath: "authOnly", constraints: [] },
        "user1",
      );
      expect(allowed.status).toBe(200);
    });

    it("should enforce list rule on POST /aggregate", async () => {
      const denied = await fetchWithAuth(ctx.port, "POST", "/aggregate", {
        collectionPath: "authOnly",
        constraints: [],
        aggregateSpec: { total: { aggregateType: "count" } },
      });
      expect(denied.status).toBe(403);
    });

    it("should enforce write rules on POST /batch", async () => {
      const denied = await fetchWithAuth(ctx.port, "POST", "/batch", {
        operations: [{ type: "set", path: "authOnly/doc2", data: { value: 2 } }],
      });
      expect(denied.status).toBe(403);

      const allowed = await fetchWithAuth(
        ctx.port,
        "POST",
        "/batch",
        { operations: [{ type: "set", path: "authOnly/doc2", data: { value: 2 } }] },
        "user1",
      );
      expect(allowed.status).toBe(200);
    });

    it("should enforce rules on transaction get / commit", async () => {
      const beginRes = await fetchWithAuth(ctx.port, "POST", "/transaction/begin");
      const { transactionId } = (await beginRes.json()) as { transactionId: string };

      const getDenied = await fetchWithAuth(ctx.port, "POST", "/transaction/get", {
        transactionId,
        path: "authOnly/doc1",
      });
      expect(getDenied.status).toBe(403);

      const commitDenied = await fetchWithAuth(ctx.port, "POST", "/transaction/commit", {
        transactionId,
        operations: [{ type: "set", path: "authOnly/doc3", data: { value: 3 } }],
      });
      expect(commitDenied.status).toBe(403);
    });
  });

  describe("realtime listener rules (WebSocket)", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        public: { read: true, write: true },
        authOnly: { read: "request.auth != null", write: "request.auth != null" },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
      await fetchWithAuth(ctx.port, "PUT", "/docs/public/doc1", { data: { value: 1 } });
      await fetchWithAuth(ctx.port, "PUT", "/docs/authOnly/doc1", { data: { value: 1 } }, "user1");
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("should deny unauthenticated doc listener with permission-denied", async () => {
      const db = getFirestore({ host: "localhost", port: ctx.port });
      try {
        const error = await new Promise<FirestoreError>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout: no error received")), 5000);
          onSnapshot(
            doc(collection(db, "authOnly"), "doc1"),
            () => {
              clearTimeout(timer);
              reject(new Error("snapshot should not be delivered"));
            },
            (err) => {
              clearTimeout(timer);
              resolve(err);
            },
          );
        });
        expect(error.code).toBe("permission-denied");
      } finally {
        await terminate(db);
      }
    });

    it("should deliver doc snapshots to authenticated listener", async () => {
      const db = getFirestore({
        host: "localhost",
        port: ctx.port,
        authTokenProvider: () => "user1",
      });
      try {
        const value = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout: no snapshot")), 5000);
          onSnapshot(
            doc(collection(db, "authOnly"), "doc1"),
            (snap) => {
              clearTimeout(timer);
              resolve(snap.data()?.value);
            },
            (err) => {
              clearTimeout(timer);
              reject(err);
            },
          );
        });
        expect(value).toBe(1);
      } finally {
        await terminate(db);
      }
    });

    it("should deny unauthenticated query listener with permission-denied", async () => {
      const db = getFirestore({ host: "localhost", port: ctx.port });
      try {
        const error = await new Promise<FirestoreError>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout: no error received")), 5000);
          onSnapshot(
            collection(db, "authOnly"),
            () => {
              clearTimeout(timer);
              reject(new Error("snapshot should not be delivered"));
            },
            (err) => {
              clearTimeout(timer);
              resolve(err);
            },
          );
        });
        expect(error.code).toBe("permission-denied");
      } finally {
        await terminate(db);
      }
    });

    it("should deliver query snapshots to listener on public collection without auth", async () => {
      const db = getFirestore({ host: "localhost", port: ctx.port });
      try {
        const size = await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout: no snapshot")), 5000);
          onSnapshot(
            collection(db, "public"),
            (snap) => {
              clearTimeout(timer);
              resolve(snap.size);
            },
            (err) => {
              clearTimeout(timer);
              reject(err);
            },
          );
        });
        expect(size).toBe(1);
      } finally {
        await terminate(db);
      }
    });
  });

  describe("per-document list evaluation (rules are not filters)", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        posts: {
          get: true,
          list: "resource.data.visibility == 'public'",
          write: true,
        },
        watched: {
          get: true,
          list: "resource.data.visibility == 'public'",
          write: true,
        },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
      await fetchWithAuth(ctx.port, "PUT", "/docs/posts/pub1", {
        data: { visibility: "public", title: "A" },
      });
      await fetchWithAuth(ctx.port, "PUT", "/docs/posts/priv1", {
        data: { visibility: "private", title: "B" },
      });
      // リスナーテスト用: 初回スナップショットが許可されるドキュメントを事前投入
      await fetchWithAuth(ctx.port, "PUT", "/docs/watched/pub1", {
        data: { visibility: "public" },
      });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("should deny an unfiltered query that would include denied documents", async () => {
      const res = await fetchWithAuth(ctx.port, "POST", "/query", {
        collectionPath: "posts",
        constraints: [],
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("permission-denied");
    });

    it("should allow a query constrained to satisfying documents", async () => {
      const res = await fetchWithAuth(ctx.port, "POST", "/query", {
        collectionPath: "posts",
        constraints: [{ type: "where", fieldPath: "visibility", op: "==", value: "public" }],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { docs: Array<{ path: string }> };
      expect(body.docs).toHaveLength(1);
      expect(body.docs[0].path).toBe("posts/pub1");
    });

    it("should apply the same evaluation to aggregate queries", async () => {
      const denied = await fetchWithAuth(ctx.port, "POST", "/aggregate", {
        collectionPath: "posts",
        constraints: [],
        aggregateSpec: { total: { aggregateType: "count" } },
      });
      expect(denied.status).toBe(403);

      const allowed = await fetchWithAuth(ctx.port, "POST", "/aggregate", {
        collectionPath: "posts",
        constraints: [{ type: "where", fieldPath: "visibility", op: "==", value: "public" }],
        aggregateSpec: { total: { aggregateType: "count" } },
      });
      expect(allowed.status).toBe(200);
      const body = (await allowed.json()) as { data: { total: number } };
      expect(body.data.total).toBe(1);
    });

    it("should terminate a query listener when a denied document enters the result set", async () => {
      const db = getFirestore({ host: "localhost", port: ctx.port });
      try {
        const snapshotPaths: string[][] = [];
        let writeTriggered = false;
        const error = await new Promise<FirestoreError>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout: no error received")), 5000);
          onSnapshot(
            collection(db, "watched"),
            (snap) => {
              snapshotPaths.push(snap.docs.map((d) => d.ref.path));
              // 初回スナップショット受信後、拒否対象のドキュメントを追加する
              if (!writeTriggered) {
                writeTriggered = true;
                fetchWithAuth(ctx.port, "PUT", "/docs/watched/priv1", {
                  data: { visibility: "private" },
                }).catch(reject);
              }
            },
            (err) => {
              clearTimeout(timer);
              resolve(err);
            },
          );
        });
        expect(error.code).toBe("permission-denied");
        // 拒否対象のドキュメントは一度もリスナーに配信されない
        expect(snapshotPaths.length).toBeGreaterThan(0);
        for (const paths of snapshotPaths) {
          expect(paths).toEqual(["watched/pub1"]);
        }
      } finally {
        await terminate(db);
      }
    });
  });

  describe("special types in rules (timestamp round-trip)", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        events: {
          read: true,
          create:
            "request.resource.data.createdAt is timestamp && request.resource.data.createdAt <= request.time",
          update: "resource.data.createdAt is timestamp",
          delete: true,
        },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("should evaluate client-written Timestamp fields as rule timestamps", async () => {
      const db = getFirestore({ host: "localhost", port: ctx.port });
      try {
        const past = Timestamp.fromDate(new Date(Date.now() - 60_000));
        // create: `is timestamp` + request.time との比較が成立する
        await setDoc(doc(collection(db, "events"), "e1"), { createdAt: past });

        // update: 保存済みデータの resource.data.createdAt が timestamp として評価される
        await setDoc(doc(collection(db, "events"), "e1"), {
          createdAt: past,
          note: "updated",
        });
      } finally {
        await terminate(db);
      }
    });

    it("should deny writes that violate timestamp rules", async () => {
      const db = getFirestore({ host: "localhost", port: ctx.port });
      try {
        // createdAt が timestamp でない → 拒否
        await expect(
          setDoc(doc(collection(db, "events"), "bad1"), { createdAt: "not-a-timestamp" }),
        ).rejects.toMatchObject({ code: "permission-denied" });

        // 未来の timestamp → request.time との比較で拒否
        const future = Timestamp.fromDate(new Date(Date.now() + 60 * 60_000));
        await expect(
          setDoc(doc(collection(db, "events"), "bad2"), { createdAt: future }),
        ).rejects.toMatchObject({ code: "permission-denied" });
      } finally {
        await terminate(db);
      }
    });
  });

  describe("cross-document references with get()/exists()", () => {
    let ctx: TestContext;
    const rules: SecurityRules = {
      rules: {
        admins: { read: true, write: true },
        secured: {
          read: "exists(path('/databases/(default)/documents/admins/$(request.auth.uid)'))",
          write:
            "get(path('/databases/(default)/documents/admins/$(request.auth.uid)')).role == 'editor'",
        },
      },
    };

    beforeAll(async () => {
      ctx = await startTestServer({ securityRules: rules });
      // アクセス制御の参照先となる管理者ドキュメントを事前投入
      await fetchWithAuth(ctx.port, "PUT", "/docs/admins/editor1", {
        data: { role: "editor" },
      });
      await fetchWithAuth(ctx.port, "PUT", "/docs/admins/viewer1", {
        data: { role: "viewer" },
      });
    });

    afterAll(async () => {
      await ctx.cleanup();
    });

    it("T11.6: get()/exists() should enforce cross-document access control", async () => {
      // editor ロールのユーザーは書き込み可能（get() で role を参照）
      const editorWrite = await fetchWithAuth(
        ctx.port,
        "PUT",
        "/docs/secured/doc1",
        { data: { value: 1 } },
        "editor1",
      );
      expect(editorWrite.status).toBe(200);

      // admins に存在しても role != editor なら書き込み不可
      const viewerWrite = await fetchWithAuth(
        ctx.port,
        "PUT",
        "/docs/secured/doc2",
        { data: { value: 2 } },
        "viewer1",
      );
      expect(viewerWrite.status).toBe(403);

      // admins にドキュメントが存在するユーザーは読み取り可能（exists()）
      const viewerRead = await fetchWithAuth(
        ctx.port,
        "GET",
        "/docs/secured/doc1",
        undefined,
        "viewer1",
      );
      expect(viewerRead.status).toBe(200);

      // admins に存在しないユーザーは読み取り不可
      const strangerRead = await fetchWithAuth(
        ctx.port,
        "GET",
        "/docs/secured/doc1",
        undefined,
        "stranger",
      );
      expect(strangerRead.status).toBe(403);

      // 未認証は request.auth が null のため評価エラーとなり拒否される
      const anonRead = await fetchWithAuth(ctx.port, "GET", "/docs/secured/doc1");
      expect(anonRead.status).toBe(403);
    });
  });
});
