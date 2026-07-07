import {
  average,
  collection,
  doc,
  getAggregateFromServer,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  sum,
  Timestamp,
  terminate,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: データ忠実度（Phase 3）", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await terminate(ctx.firestore);
    await ctx.cleanup();
  });

  describe("非有限数値（NaN / Infinity）", () => {
    it("NaN / Infinity が round-trip する", async () => {
      const ref = doc(collection(ctx.firestore, "nums"), "special");
      await setDoc(ref, {
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        ninf: Number.NEGATIVE_INFINITY,
        normal: 1.5,
      });
      const snap = await getDoc(ref);
      const data = snap.data();
      expect(Number.isNaN(data?.nan as number)).toBe(true);
      expect(data?.inf).toBe(Number.POSITIVE_INFINITY);
      expect(data?.ninf).toBe(Number.NEGATIVE_INFINITY);
      expect(data?.normal).toBe(1.5);
    });

    it("NaN は数値の最小としてソートされ、== NaN フィルタが機能する", async () => {
      const col = collection(ctx.firestore, "sortable");
      await setDoc(doc(col, "nan"), { v: Number.NaN });
      await setDoc(doc(col, "neginf"), { v: Number.NEGATIVE_INFINITY });
      await setDoc(doc(col, "zero"), { v: 0 });

      const ordered = await getDocs(query(col, orderBy("v")));
      expect(ordered.docs.map((d) => d.id)).toEqual(["nan", "neginf", "zero"]);

      const nanOnly = await getDocs(query(col, where("v", "==", Number.NaN)));
      expect(nanOnly.docs.map((d) => d.id)).toEqual(["nan"]);
    });
  });

  describe("Timestamp のマイクロ秒精度（C-2）", () => {
    it("ナノ秒精度の Timestamp はマイクロ秒に切り捨てて保存される", async () => {
      const ref = doc(collection(ctx.firestore, "events"), "e1");
      await setDoc(ref, { at: new Timestamp(1700000000, 123_456_789) });
      const snap = await getDoc(ref);
      const at = snap.data()?.at as Timestamp;
      expect(at.seconds).toBe(1700000000);
      expect(at.nanoseconds).toBe(123_456_000);
    });

    it("createTime / updateTime がマイクロ秒精度で返る", async () => {
      const ref = doc(collection(ctx.firestore, "events"), "e2");
      await setDoc(ref, { v: 1 });
      const snap = await getDoc(ref);
      const createTime = snap.createTime;
      expect(createTime).toBeDefined();
      // マイクロ秒精度（ナノ秒下3桁は常に0）で丸め誤差なく取得できる
      expect((createTime as Timestamp).nanoseconds % 1000).toBe(0);
    });
  });

  describe("sum / avg の非数値スキップ（C-3）", () => {
    it("文字列混在フィールドの sum / avg が数値のみで計算される", async () => {
      const col = collection(ctx.firestore, "mixed");
      await setDoc(doc(col, "a"), { v: 10 });
      await setDoc(doc(col, "b"), { v: 20 });
      await setDoc(doc(col, "c"), { v: "thirty" });

      const result = await getAggregateFromServer(query(col), {
        total: sum("v"),
        avg: average("v"),
      });
      expect(result.data().total).toBe(30);
      expect(result.data().avg).toBe(15);
    });
  });

  describe("旧形式データのマイグレーション（C-4: import 経路）", () => {
    it("import で素の {seconds, nanoseconds} マップが Timestamp に変換される", async () => {
      const res = await fetch(`http://localhost:${ctx.port}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documents: [
            {
              path: "legacy/doc1",
              data: { createdAt: { seconds: 1700000000, nanoseconds: 500_000_000 } },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);

      const snap = await getDoc(doc(collection(ctx.firestore, "legacy"), "doc1"));
      const createdAt = snap.data()?.createdAt as Timestamp;
      expect(createdAt).toBeInstanceOf(Timestamp);
      expect(createdAt.seconds).toBe(1700000000);
      expect(createdAt.nanoseconds).toBe(500_000_000);
    });
  });
});
