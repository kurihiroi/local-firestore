import {
  collection,
  doc,
  endAt,
  endBefore,
  getDoc,
  getDocs,
  limit,
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

describe("E2E: Snapshot cursor pagination", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
    const col = collection(ctx.firestore, "snapPages");
    // score が同値のドキュメントを含める（__name__ タイブレークの検証用）
    await setDoc(doc(col, "a"), { name: "A", score: 10 });
    await setDoc(doc(col, "b"), { name: "B", score: 20 });
    await setDoc(doc(col, "c"), { name: "C", score: 20 });
    await setDoc(doc(col, "d"), { name: "D", score: 30 });
    await setDoc(doc(col, "e"), { name: "E", score: 40 });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("startAfter(snapshot) で次のページを取得できる", async () => {
    const col = collection(ctx.firestore, "snapPages");
    const page1 = await getDocs(query(col, orderBy("score"), limit(2)));
    expect(page1.docs.map((d: QueryDocumentSnapshot) => d.id)).toEqual(["a", "b"]);

    const lastDoc = page1.docs[page1.size - 1];
    const page2 = await getDocs(query(col, orderBy("score"), startAfter(lastDoc), limit(2)));
    expect(page2.docs.map((d: QueryDocumentSnapshot) => d.id)).toEqual(["c", "d"]);

    const page3 = await getDocs(
      query(col, orderBy("score"), startAfter(page2.docs[page2.size - 1]), limit(2)),
    );
    expect(page3.docs.map((d: QueryDocumentSnapshot) => d.id)).toEqual(["e"]);
  });

  it("同値フィールドでも __name__ タイブレークで正しくスキップされる", async () => {
    const col = collection(ctx.firestore, "snapPages");
    // b と c は score=20 で同値。b のスナップショットで startAfter すると c から始まる
    const all = await getDocs(query(col, orderBy("score")));
    const bSnap = all.docs.find((d: QueryDocumentSnapshot) => d.id === "b");
    if (!bSnap) throw new Error("doc b not found");

    const after = await getDocs(query(col, orderBy("score"), startAfter(bSnap)));
    expect(after.docs.map((d: QueryDocumentSnapshot) => d.id)).toEqual(["c", "d", "e"]);
  });

  it("startAt / endAt にもスナップショットを渡せる", async () => {
    const col = collection(ctx.firestore, "snapPages");
    const all = await getDocs(query(col, orderBy("score")));
    const cSnap = all.docs.find((d: QueryDocumentSnapshot) => d.id === "c");
    const dSnap = all.docs.find((d: QueryDocumentSnapshot) => d.id === "d");
    if (!cSnap || !dSnap) throw new Error("docs not found");

    const range = await getDocs(query(col, orderBy("score"), startAt(cSnap), endAt(dSnap)));
    expect(range.docs.map((d: QueryDocumentSnapshot) => d.id)).toEqual(["c", "d"]);
  });

  it("getDoc の DocumentSnapshot もカーソルに使える", async () => {
    const col = collection(ctx.firestore, "snapPages");
    const bDoc = await getDoc(doc(col, "b"));
    expect(bDoc.exists()).toBe(true);

    const after = await getDocs(query(col, orderBy("score"), startAfter(bDoc)));
    expect(after.docs.map((d: QueryDocumentSnapshot) => d.id)).toEqual(["c", "d", "e"]);
  });

  it("orderBy なしの snapshot カーソルは __name__ 順で機能する", async () => {
    const col = collection(ctx.firestore, "snapPages");
    const all = await getDocs(query(col, orderBy("__name__")));
    const cSnap = all.docs.find((d: QueryDocumentSnapshot) => d.id === "c");
    if (!cSnap) throw new Error("doc c not found");

    const after = await getDocs(query(col, startAfter(cSnap)));
    expect(after.docs.map((d: QueryDocumentSnapshot) => d.id)).toEqual(["d", "e"]);
  });
});
