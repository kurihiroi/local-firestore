import { collection, doc, getDoc, setDoc, updateDoc } from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: CRUD extended operations", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T1.7: setDoc with merge:true should preserve existing fields", async () => {
    const ref = doc(collection(ctx.firestore, "merge-test"), "doc1");
    await setDoc(ref, { name: "Alice", age: 30, email: "alice@example.com" });

    await setDoc(ref, { age: 31, city: "Tokyo" }, { merge: true });

    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({
      name: "Alice",
      age: 31,
      email: "alice@example.com",
      city: "Tokyo",
    });
  });

  it("T1.8: setDoc with mergeFields should merge only specified fields", async () => {
    const ref = doc(collection(ctx.firestore, "merge-test"), "doc2");
    await setDoc(ref, { name: "Bob", age: 25, email: "bob@example.com" });

    await setDoc(ref, { age: 26, city: "Osaka" }, { mergeFields: ["age"] });

    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({
      name: "Bob",
      age: 26,
      email: "bob@example.com",
    });
  });

  it("T1.9: updateDoc on non-existent document should throw error", async () => {
    const ref = doc(collection(ctx.firestore, "merge-test"), "nonexistent");
    await expect(updateDoc(ref, { name: "Ghost" })).rejects.toThrow();
  });
});
