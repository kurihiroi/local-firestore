import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  setDoc,
  startAfter,
  Timestamp,
  updateDoc,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

/**
 * 本家 Firestore との挙動互換性を検証する E2E テスト
 */
describe("E2E: Firestore互換性", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe("Timestamp の round-trip", () => {
    it("書き込んだ Timestamp が Timestamp インスタンスとして読み出せる", async () => {
      const ref = doc(collection(ctx.firestore, "compat-ts"), "t1");
      const ts = Timestamp.fromDate(new Date("2025-06-01T12:00:00Z"));
      await setDoc(ref, { at: ts, nested: { at: ts } });

      const snap = await getDoc(ref);
      const data = snap.data() as { at: Timestamp; nested: { at: Timestamp } };
      expect(data.at).toBeInstanceOf(Timestamp);
      expect(data.at.isEqual(ts)).toBe(true);
      expect(data.at.toDate().toISOString()).toBe("2025-06-01T12:00:00.000Z");
      expect(data.nested.at).toBeInstanceOf(Timestamp);
    });

    it("Date を書き込むと Timestamp として読み出せる", async () => {
      const ref = doc(collection(ctx.firestore, "compat-ts"), "t2");
      await setDoc(ref, { at: new Date("2025-06-01T12:00:00Z") });

      const snap = await getDoc(ref);
      expect((snap.data() as { at: Timestamp }).at).toBeInstanceOf(Timestamp);
    });
  });

  describe("Timestamp のクエリ", () => {
    beforeAll(async () => {
      const col = collection(ctx.firestore, "compat-events");
      await setDoc(doc(col, "e1"), { at: Timestamp.fromMillis(1000) });
      await setDoc(doc(col, "e2"), { at: Timestamp.fromMillis(2000) });
      await setDoc(doc(col, "e3"), { at: Timestamp.fromMillis(3000) });
    });

    it("Timestamp の範囲フィルタが機能する", async () => {
      const snap = await getDocs(
        query(
          collection(ctx.firestore, "compat-events"),
          where("at", ">", Timestamp.fromMillis(1000)),
        ),
      );
      expect(snap.docs.map((d) => d.id).sort()).toEqual(["e2", "e3"]);
    });

    it("Timestamp の orderBy + カーソルが機能する", async () => {
      const snap = await getDocs(
        query(
          collection(ctx.firestore, "compat-events"),
          orderBy("at", "desc"),
          startAfter(Timestamp.fromMillis(3000)),
        ),
      );
      expect(snap.docs.map((d) => d.id)).toEqual(["e2", "e1"]);
    });
  });

  describe("updateDoc のドット記法", () => {
    it("兄弟フィールドを保持したままネストフィールドを更新する", async () => {
      const ref = doc(collection(ctx.firestore, "compat-update"), "u1");
      await setDoc(ref, { address: { city: "Tokyo", zip: "100-0001" }, name: "Alice" });

      await updateDoc(ref, "address.city", "Osaka");

      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({
        address: { city: "Osaka", zip: "100-0001" },
        name: "Alice",
      });
    });

    it("オブジェクト形式のドット記法キーでも兄弟フィールドを保持する", async () => {
      const ref = doc(collection(ctx.firestore, "compat-update"), "u2");
      await setDoc(ref, { a: { b: 1, c: 2 } });

      await updateDoc(ref, { "a.b": 10 });

      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({ a: { b: 10, c: 2 } });
    });
  });

  describe("setDoc の merge", () => {
    it("ネストしたマップを再帰的にマージする", async () => {
      const ref = doc(collection(ctx.firestore, "compat-merge"), "m1");
      await setDoc(ref, { profile: { name: "Alice", age: 30 }, active: true });

      await setDoc(ref, { profile: { age: 31 } }, { merge: true });

      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({
        profile: { name: "Alice", age: 31 },
        active: true,
      });
    });
  });

  describe("クエリ順序の互換性", () => {
    it("orderBy 対象フィールドが無いドキュメントは除外される", async () => {
      const col = collection(ctx.firestore, "compat-order");
      await setDoc(doc(col, "a"), { rank: 2 });
      await setDoc(doc(col, "b"), { other: 1 });
      await setDoc(doc(col, "c"), { rank: 1 });

      const snap = await getDocs(query(col, orderBy("rank")));
      expect(snap.docs.map((d) => d.id)).toEqual(["c", "a"]);
    });

    it("orderBy なしはドキュメントID順で安定する", async () => {
      const col = collection(ctx.firestore, "compat-order2");
      await setDoc(doc(col, "c"), { v: 1 });
      await setDoc(doc(col, "a"), { v: 2 });
      await setDoc(doc(col, "b"), { v: 3 });

      const snap = await getDocs(col);
      expect(snap.docs.map((d) => d.id)).toEqual(["a", "b", "c"]);
    });
  });

  describe("認証トークン付きクライアント", () => {
    it("authTokenProvider のトークンでセキュリティルールを通過できる", async () => {
      const authedCtx = await startTestServer({
        securityRules: {
          rules: {
            secure: { read: "request.auth != null", write: "request.auth != null" },
          },
        },
      });
      try {
        // トークンなし → 拒否
        const anonRef = doc(collection(authedCtx.firestore, "secure"), "d1");
        await expect(setDoc(anonRef, { v: 1 })).rejects.toMatchObject({
          code: "permission-denied",
        });

        // トークンあり → 許可（LocalAuthProvider は Bearer <uid> を解釈する）
        const authedDb = getFirestore({
          host: "localhost",
          port: authedCtx.port,
          authTokenProvider: () => "user123",
        });
        const ref = doc(collection(authedDb, "secure"), "d1");
        await setDoc(ref, { v: 1 });
        const snap = await getDoc(ref);
        expect(snap.data()).toEqual({ v: 1 });
      } finally {
        await authedCtx.cleanup();
      }
    });
  });
});
