import { collection, doc, getDoc, setDoc } from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Import/Export", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T12.1: export should return all documents as JSON", async () => {
    const col = collection(ctx.firestore, "export-test");
    await setDoc(doc(col, "e1"), { name: "A" });
    await setDoc(doc(col, "e2"), { name: "B" });

    const res = await fetch(`http://localhost:${ctx.port}/export`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version).toBe(1);
    expect(data.exportedAt).toBeDefined();
    expect(Array.isArray(data.documents)).toBe(true);

    const exportDocs = data.documents.filter(
      (d: Record<string, unknown>) =>
        typeof d.path === "string" && (d.path as string).startsWith("export-test/"),
    );
    expect(exportDocs.length).toBe(2);
  });

  it("T12.2: import should load documents from JSON", async () => {
    const importData = {
      documents: [
        { path: "import-test/i1", data: { name: "Imported1" } },
        { path: "import-test/i2", data: { name: "Imported2" } },
      ],
    };

    const res = await fetch(`http://localhost:${ctx.port}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(importData),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.imported).toBe(2);

    const snap1 = await getDoc(doc(collection(ctx.firestore, "import-test"), "i1"));
    expect(snap1.exists()).toBe(true);
    expect(snap1.data()).toEqual({ name: "Imported1" });
  });

  it("T12.3: import with clean:true should delete existing data first", async () => {
    // Seed some data
    await setDoc(doc(collection(ctx.firestore, "clean-test"), "old"), { value: "old" });

    const importData = {
      clean: true,
      documents: [{ path: "clean-test/new", data: { value: "new" } }],
    };

    await fetch(`http://localhost:${ctx.port}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(importData),
    });

    // Old document should be gone
    const oldSnap = await getDoc(doc(collection(ctx.firestore, "clean-test"), "old"));
    expect(oldSnap.exists()).toBe(false);

    // New document should exist
    const newSnap = await getDoc(doc(collection(ctx.firestore, "clean-test"), "new"));
    expect(newSnap.exists()).toBe(true);
    expect(newSnap.data()).toEqual({ value: "new" });
  });

  it("T12.4: export then import round-trip should preserve data", async () => {
    // Create data
    await setDoc(doc(collection(ctx.firestore, "roundtrip"), "r1"), {
      value: 42,
      nested: { a: 1 },
    });

    // Export
    const exportRes = await fetch(`http://localhost:${ctx.port}/export`);
    const exported = await exportRes.json();
    const rtDoc = exported.documents.find(
      (d: Record<string, unknown>) => d.path === "roundtrip/r1",
    );
    expect(rtDoc).toBeDefined();

    // Clean and re-import
    await fetch(`http://localhost:${ctx.port}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clean: true, documents: [rtDoc] }),
    });

    // Verify data preserved
    const snap = await getDoc(doc(collection(ctx.firestore, "roundtrip"), "r1"));
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ value: 42, nested: { a: 1 } });
  });
});
