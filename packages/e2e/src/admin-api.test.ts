import { collection, doc, getDoc, setDoc } from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Admin API", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
    const col = collection(ctx.firestore, "admin-test");
    await setDoc(doc(col, "d1"), { name: "Doc1", value: 1 });
    await setDoc(doc(col, "d2"), { name: "Doc2", value: 2 });
    await setDoc(doc(col, "d3"), { name: "Doc3", value: 3 });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T14.1: /admin/api/collections should list all collections", async () => {
    const res = await fetch(`http://localhost:${ctx.port}/admin/api/collections`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.collections).toBeDefined();
    expect(Array.isArray(data.collections)).toBe(true);
    expect(data.collections).toContain("admin-test");
  });

  it("T14.2: /admin/api/documents should list documents in collection", async () => {
    const res = await fetch(
      `http://localhost:${ctx.port}/admin/api/documents?collection=admin-test`,
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents).toBeDefined();
    expect(Array.isArray(data.documents)).toBe(true);
    expect(data.documents.length).toBe(3);
  });

  it("T14.3: /admin/api/document should edit and delete documents", async () => {
    // Edit
    const editRes = await fetch(
      `http://localhost:${ctx.port}/admin/api/document?path=admin-test/d1`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { name: "Updated", value: 99 } }),
      },
    );
    expect(editRes.status).toBe(200);

    const snap = await getDoc(doc(collection(ctx.firestore, "admin-test"), "d1"));
    expect(snap.data()).toEqual({ name: "Updated", value: 99 });

    // Delete
    const delRes = await fetch(
      `http://localhost:${ctx.port}/admin/api/document?path=admin-test/d3`,
      { method: "DELETE" },
    );
    expect(delRes.status).toBe(200);

    const deleted = await getDoc(doc(collection(ctx.firestore, "admin-test"), "d3"));
    expect(deleted.exists()).toBe(false);
  });
});
