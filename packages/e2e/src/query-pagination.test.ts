import {
  collection,
  doc,
  endAt,
  endBefore,
  getDocs,
  limitToLast,
  orderBy,
  type QueryDocumentSnapshot,
  query,
  setDoc,
  startAfter,
  startAt,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Query pagination", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
    const col = collection(ctx.firestore, "pages");
    await setDoc(doc(col, "d1"), { name: "A", score: 10, rank: 1 });
    await setDoc(doc(col, "d2"), { name: "B", score: 20, rank: 2 });
    await setDoc(doc(col, "d3"), { name: "C", score: 30, rank: 3 });
    await setDoc(doc(col, "d4"), { name: "D", score: 40, rank: 4 });
    await setDoc(doc(col, "d5"), { name: "E", score: 50, rank: 5 });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T5.3: limitToLast should return last N results", async () => {
    const col = collection(ctx.firestore, "pages");
    const q = query(col, orderBy("score", "asc"), limitToLast(2));
    const snap = await getDocs(q);
    expect(snap.size).toBe(2);
    const names = snap.docs.map((d: QueryDocumentSnapshot) => d.data().name);
    expect(names).toEqual(["D", "E"]);
  });

  it("T5.4: startAt/startAfter should paginate from cursor", async () => {
    const col = collection(ctx.firestore, "pages");

    const qAt = query(col, orderBy("score", "asc"), startAt(30));
    const snapAt = await getDocs(qAt);
    expect(snapAt.size).toBe(3);
    expect(snapAt.docs[0].data().name).toBe("C");

    const qAfter = query(col, orderBy("score", "asc"), startAfter(30));
    const snapAfter = await getDocs(qAfter);
    expect(snapAfter.size).toBe(2);
    expect(snapAfter.docs[0].data().name).toBe("D");
  });

  it("T5.5: endAt/endBefore should limit cursor end", async () => {
    const col = collection(ctx.firestore, "pages");

    const qAt = query(col, orderBy("score", "asc"), endAt(30));
    const snapAt = await getDocs(qAt);
    expect(snapAt.size).toBe(3);
    expect(snapAt.docs[snapAt.size - 1].data().name).toBe("C");

    const qBefore = query(col, orderBy("score", "asc"), endBefore(30));
    const snapBefore = await getDocs(qBefore);
    expect(snapBefore.size).toBe(2);
    expect(snapBefore.docs[snapBefore.size - 1].data().name).toBe("B");
  });

  it("T5.7: multiple orderBy fields should sort correctly", async () => {
    const col = collection(ctx.firestore, "multi-sort");
    await setDoc(doc(col, "m1"), { group: "X", value: 3 });
    await setDoc(doc(col, "m2"), { group: "X", value: 1 });
    await setDoc(doc(col, "m3"), { group: "Y", value: 2 });
    await setDoc(doc(col, "m4"), { group: "Y", value: 4 });

    const q = query(col, orderBy("group", "asc"), orderBy("value", "asc"));
    const snap = await getDocs(q);
    const values = snap.docs.map((d: QueryDocumentSnapshot) => d.data().value);
    expect(values).toEqual([1, 3, 2, 4]);
  });
});
