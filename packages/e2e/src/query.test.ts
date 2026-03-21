import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  where,
} from "@local-firestore/client";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Query operations", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();

    // Seed data
    const col = collection(ctx.firestore, "products");
    await setDoc(doc(col, "p1"), { name: "Apple", price: 100, category: "fruit" });
    await setDoc(doc(col, "p2"), { name: "Banana", price: 50, category: "fruit" });
    await setDoc(doc(col, "p3"), { name: "Carrot", price: 80, category: "vegetable" });
    await setDoc(doc(col, "p4"), { name: "Donut", price: 200, category: "snack" });
    await setDoc(doc(col, "p5"), { name: "Eggplant", price: 120, category: "vegetable" });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("should get all documents in a collection", async () => {
    const col = collection(ctx.firestore, "products");
    const snap = await getDocs(query(col));
    expect(snap.size).toBe(5);
  });

  it("should filter with where clause", async () => {
    const col = collection(ctx.firestore, "products");
    const q = query(col, where("category", "==", "fruit"));
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
    snap.forEach((d) => {
      expect(d.data().category).toBe("fruit");
    });
  });

  it("should order results", async () => {
    const col = collection(ctx.firestore, "products");
    const q = query(col, orderBy("price", "asc"));
    const snap = await getDocs(q);
    const prices = snap.docs.map((d) => d.data().price as number);
    expect(prices).toEqual([50, 80, 100, 120, 200]);
  });

  it("should limit results", async () => {
    const col = collection(ctx.firestore, "products");
    const q = query(col, orderBy("price", "asc"), limit(3));
    const snap = await getDocs(q);
    expect(snap.size).toBe(3);
    const prices = snap.docs.map((d) => d.data().price as number);
    expect(prices).toEqual([50, 80, 100]);
  });

  it("should combine where and orderBy", async () => {
    const col = collection(ctx.firestore, "products");
    const q = query(col, where("price", ">=", 100), orderBy("price", "desc"));
    const snap = await getDocs(q);
    expect(snap.size).toBe(3);
    const names = snap.docs.map((d) => d.data().name);
    expect(names).toEqual(["Donut", "Eggplant", "Apple"]);
  });
});
