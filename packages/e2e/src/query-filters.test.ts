import {
  and,
  collection,
  doc,
  getDocs,
  or,
  type QueryDocumentSnapshot,
  query,
  setDoc,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Query filters", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
    const col = collection(ctx.firestore, "items");
    await setDoc(doc(col, "i1"), { name: "Alpha", price: 100, category: "A", tags: ["x", "y"] });
    await setDoc(doc(col, "i2"), { name: "Beta", price: 200, category: "B", tags: ["y", "z"] });
    await setDoc(doc(col, "i3"), { name: "Gamma", price: 150, category: "A", tags: ["x"] });
    await setDoc(doc(col, "i4"), { name: "Delta", price: 300, category: "C", tags: ["z"] });
    await setDoc(doc(col, "i5"), { name: "Epsilon", price: 250, category: "B", tags: ["x", "z"] });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T4.2: != filter should exclude matching documents", async () => {
    const col = collection(ctx.firestore, "items");
    const q = query(col, where("category", "!=", "A"));
    const snap = await getDocs(q);
    expect(snap.size).toBe(3);
    snap.forEach((d: QueryDocumentSnapshot) => {
      expect(d.data().category).not.toBe("A");
    });
  });

  it("T4.3: comparison filters (<, <=, >, >=) should work", async () => {
    const col = collection(ctx.firestore, "items");

    const qLt = query(col, where("price", "<", 200));
    const snapLt = await getDocs(qLt);
    expect(snapLt.size).toBe(2);

    const qGte = query(col, where("price", ">=", 200));
    const snapGte = await getDocs(qGte);
    expect(snapGte.size).toBe(3);
  });

  it("T4.4: array-contains filter should match array elements", async () => {
    const col = collection(ctx.firestore, "items");
    const q = query(col, where("tags", "array-contains", "x"));
    const snap = await getDocs(q);
    expect(snap.size).toBe(3);
  });

  it("T4.5: array-contains-any filter should match any element", async () => {
    const col = collection(ctx.firestore, "items");
    const q = query(col, where("tags", "array-contains-any", ["y"]));
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
  });

  it("T4.6: in filter should match values in list", async () => {
    const col = collection(ctx.firestore, "items");
    const q = query(col, where("category", "in", ["A", "C"]));
    const snap = await getDocs(q);
    expect(snap.size).toBe(3);
  });

  it("T4.7: not-in filter should exclude values in list", async () => {
    const col = collection(ctx.firestore, "items");
    const q = query(col, where("category", "not-in", ["A", "C"]));
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
    snap.forEach((d: QueryDocumentSnapshot) => {
      expect(d.data().category).toBe("B");
    });
  });

  it("T4.8: and() composite filter should combine conditions", async () => {
    const col = collection(ctx.firestore, "items");
    const q = query(col, and(where("category", "==", "A"), where("price", ">", 100)));
    const snap = await getDocs(q);
    expect(snap.size).toBe(1);
    expect(snap.docs[0].data().name).toBe("Gamma");
  });

  it("T4.9: or() composite filter should match either condition", async () => {
    const col = collection(ctx.firestore, "items");
    const q = query(col, or(where("category", "==", "C"), where("price", "<", 150)));
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
    const names = snap.docs.map((d: QueryDocumentSnapshot) => d.data().name);
    expect(names).toContain("Alpha");
    expect(names).toContain("Delta");
  });
});
