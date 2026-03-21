import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collection,
  doc,
  getDoc,
  runTransaction,
  setDoc,
  writeBatch,
} from "@local-firestore/client";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Batch & Transaction operations", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe("writeBatch", () => {
    it("should commit multiple writes atomically", async () => {
      const col = collection(ctx.firestore, "batch-test");
      const batch = writeBatch(ctx.firestore);

      batch.set(doc(col, "d1"), { value: 1 });
      batch.set(doc(col, "d2"), { value: 2 });
      batch.set(doc(col, "d3"), { value: 3 });
      await batch.commit();

      const s1 = await getDoc(doc(col, "d1"));
      const s2 = await getDoc(doc(col, "d2"));
      const s3 = await getDoc(doc(col, "d3"));

      expect(s1.data()).toEqual({ value: 1 });
      expect(s2.data()).toEqual({ value: 2 });
      expect(s3.data()).toEqual({ value: 3 });
    });

    it("should support delete in batch", async () => {
      const col = collection(ctx.firestore, "batch-del");
      await setDoc(doc(col, "to-delete"), { temp: true });

      const batch = writeBatch(ctx.firestore);
      batch.delete(doc(col, "to-delete"));
      await batch.commit();

      const snap = await getDoc(doc(col, "to-delete"));
      expect(snap.exists()).toBe(false);
    });
  });

  describe("runTransaction", () => {
    it("should read and write within a transaction", async () => {
      const ref = doc(collection(ctx.firestore, "accounts"), "acc1");
      await setDoc(ref, { balance: 1000 });

      await runTransaction(ctx.firestore, async (tx) => {
        const snap = await tx.get(ref);
        const balance = (snap.data() as { balance: number }).balance;
        tx.update(ref, { balance: balance - 200 });
      });

      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({ balance: 800 });
    });
  });
});
