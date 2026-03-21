import {
  collection,
  doc,
  getDoc,
  runTransaction,
  setDoc,
  type Transaction,
  writeBatch,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Batch & Transaction extended", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe("writeBatch extended", () => {
    it("T8.3: batch should combine set, update, and delete atomically", async () => {
      const col = collection(ctx.firestore, "batch-atomic");
      await setDoc(doc(col, "existing1"), { value: "old" });
      await setDoc(doc(col, "toDelete"), { value: "gone" });

      const batch = writeBatch(ctx.firestore);
      batch.set(doc(col, "new1"), { value: "created" });
      batch.update(doc(col, "existing1"), { value: "updated" });
      batch.delete(doc(col, "toDelete"));
      await batch.commit();

      const newSnap = await getDoc(doc(col, "new1"));
      expect(newSnap.data()).toEqual({ value: "created" });

      const updatedSnap = await getDoc(doc(col, "existing1"));
      expect(updatedSnap.data()).toEqual({ value: "updated" });

      const deletedSnap = await getDoc(doc(col, "toDelete"));
      expect(deletedSnap.exists()).toBe(false);
    });
  });

  describe("runTransaction extended", () => {
    it("T9.2: read-modify-write should work correctly in transaction", async () => {
      const ref1 = doc(collection(ctx.firestore, "tx-test"), "account-a");
      const ref2 = doc(collection(ctx.firestore, "tx-test"), "account-b");
      await setDoc(ref1, { balance: 500 });
      await setDoc(ref2, { balance: 300 });

      // Transfer 100 from account-a to account-b
      await runTransaction(ctx.firestore, async (tx: Transaction) => {
        const snapA = await tx.get(ref1);
        const snapB = await tx.get(ref2);
        const balA = (snapA.data() as { balance: number }).balance;
        const balB = (snapB.data() as { balance: number }).balance;
        tx.update(ref1, { balance: balA - 100 });
        tx.update(ref2, { balance: balB + 100 });
      });

      const finalA = await getDoc(ref1);
      const finalB = await getDoc(ref2);
      expect(finalA.data()).toEqual({ balance: 400 });
      expect(finalB.data()).toEqual({ balance: 400 });
    });

    it("T9.3: transaction should return result value", async () => {
      const ref = doc(collection(ctx.firestore, "tx-test"), "return-val");
      await setDoc(ref, { count: 42 });

      const result = await runTransaction(ctx.firestore, async (tx: Transaction) => {
        const snap = await tx.get(ref);
        const count = (snap.data() as { count: number }).count;
        tx.update(ref, { count: count + 1 });
        return count;
      });

      expect(result).toBe(42);
      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({ count: 43 });
    });
  });
});
