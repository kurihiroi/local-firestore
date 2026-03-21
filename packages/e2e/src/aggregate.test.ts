import {
  average,
  collection,
  count,
  doc,
  getAggregateFromServer,
  getCountFromServer,
  query,
  setDoc,
  sum,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Aggregate queries", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
    const col = collection(ctx.firestore, "agg-items");
    await setDoc(doc(col, "a1"), { name: "X", price: 100, category: "A" });
    await setDoc(doc(col, "a2"), { name: "Y", price: 200, category: "A" });
    await setDoc(doc(col, "a3"), { name: "Z", price: 300, category: "B" });
    await setDoc(doc(col, "a4"), { name: "W", price: 400, category: "B" });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T7.1: count() should return document count", async () => {
    const col = collection(ctx.firestore, "agg-items");
    const snap = await getCountFromServer(query(col));
    expect(snap.data().count).toBe(4);
  });

  it("T7.2: sum(field) should return sum of numeric field", async () => {
    const col = collection(ctx.firestore, "agg-items");
    const snap = await getAggregateFromServer(query(col), {
      totalPrice: sum("price"),
    });
    expect(snap.data().totalPrice).toBe(1000);
  });

  it("T7.3: avg(field) should return average of numeric field", async () => {
    const col = collection(ctx.firestore, "agg-items");
    const snap = await getAggregateFromServer(query(col), {
      avgPrice: average("price"),
    });
    expect(snap.data().avgPrice).toBe(250);
  });

  it("T7.4: aggregate with where filter should apply filter first", async () => {
    const col = collection(ctx.firestore, "agg-items");
    const q = query(col, where("category", "==", "A"));
    const snap = await getAggregateFromServer(q, {
      count: count(),
      total: sum("price"),
    });
    expect(snap.data().count).toBe(2);
    expect(snap.data().total).toBe(300);
  });
});
