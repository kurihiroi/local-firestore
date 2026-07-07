import {
  collection,
  deleteField,
  doc,
  type FirestoreError,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  terminate,
  updateDoc,
  where,
  writeBatch,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: プラットフォームリミットとバリデーション（Phase 2）", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await terminate(ctx.firestore);
    await ctx.cleanup();
  });

  describe("書き込みバリデーション（B-3）", () => {
    it("undefined 値の setDoc はデフォルトでエラーになる", async () => {
      await expect(
        setDoc(doc(collection(ctx.firestore, "items"), "u1"), { a: 1, b: undefined }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    });

    it("ignoreUndefinedProperties: true で undefined 値が除外される", async () => {
      const db = getFirestore({
        host: "localhost",
        port: ctx.port,
        ignoreUndefinedProperties: true,
      });
      try {
        const ref = doc(collection(db, "items"), "u2");
        await setDoc(ref, { a: 1, b: undefined });
        const snap = await getDoc(ref);
        expect(snap.data()).toEqual({ a: 1 });
      } finally {
        await terminate(db);
      }
    });

    it("配列内の FieldValue センチネルはエラーになる", async () => {
      await expect(
        setDoc(doc(collection(ctx.firestore, "items"), "u3"), { list: [serverTimestamp()] }),
      ).rejects.toMatchObject({ code: "invalid-argument" });
    });
  });

  describe("プラットフォームリミット（B-1）", () => {
    it("1 MiB 超のドキュメントはサーバーで invalid-argument になる", async () => {
      const res = await fetch(`http://localhost:${ctx.port}/docs/items/big`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { v: "x".repeat(1_048_576) } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("invalid-argument");
    });

    it("バッチの 501 オペレーション目でクライアントエラーになる", () => {
      const batch = writeBatch(ctx.firestore);
      for (let i = 0; i < 500; i++) {
        batch.set(doc(collection(ctx.firestore, "bulk"), `d${i}`), { i });
      }
      let error: FirestoreError | undefined;
      try {
        batch.set(doc(collection(ctx.firestore, "bulk"), "over"), { i: 500 });
      } catch (e) {
        error = e as FirestoreError;
      }
      expect(error?.code).toBe("invalid-argument");
    });

    it("予約フィールド名（__.*__）はサーバーで invalid-argument になる", async () => {
      const res = await fetch(`http://localhost:${ctx.port}/docs/items/reserved`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { __id__: 1 } }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("クエリバリデーション（B-2）", () => {
    it("in の31要素以上は getDocs で invalid-argument になる", async () => {
      const values = Array.from({ length: 31 }, (_, i) => i);
      const q = query(collection(ctx.firestore, "items"), where("a", "in", values));
      await expect(getDocs(q)).rejects.toMatchObject({ code: "invalid-argument" });
    });

    it("not-in と != の併用は invalid-argument になる", async () => {
      const q = query(
        collection(ctx.firestore, "items"),
        where("a", "not-in", [1]),
        where("b", "!=", 2),
      );
      await expect(getDocs(q)).rejects.toMatchObject({ code: "invalid-argument" });
    });

    it("サーバー単体でも防御的に検証される（/query 直叩き）", async () => {
      const res = await fetch(`http://localhost:${ctx.port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionPath: "items",
          constraints: [
            { type: "where", fieldPath: "a", op: "array-contains", value: 1 },
            { type: "where", fieldPath: "b", op: "array-contains", value: 2 },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("invalid-argument");
    });
  });

  describe("deleteField のプロトコル表現（B-4）", () => {
    it("文字列 $$__DELETE__$$ の書き込みはフィールド削除にならない", async () => {
      const ref = doc(collection(ctx.firestore, "sentinels"), "s1");
      await setDoc(ref, { note: "$$__DELETE__$$", keep: 1 });
      const snap = await getDoc(ref);
      expect(snap.data()).toEqual({ note: "$$__DELETE__$$", keep: 1 });

      // merge set でも文字列はそのまま保持される
      await setDoc(ref, { note: "$$__DELETE__$$" }, { merge: true });
      const snap2 = await getDoc(ref);
      expect(snap2.data()?.note).toBe("$$__DELETE__$$");
    });

    it("deleteField() は updateDoc / merge set で機能する", async () => {
      const ref = doc(collection(ctx.firestore, "sentinels"), "s2");
      await setDoc(ref, { a: 1, b: 2, nested: { x: 1, y: 2 } });

      await updateDoc(ref, { a: deleteField() });
      expect((await getDoc(ref)).data()).toEqual({ b: 2, nested: { x: 1, y: 2 } });

      await setDoc(ref, { nested: { x: deleteField() } }, { merge: true });
      expect((await getDoc(ref)).data()).toEqual({ b: 2, nested: { y: 2 } });
    });

    it("merge なしの setDoc で deleteField() はエラーになる", async () => {
      const ref = doc(collection(ctx.firestore, "sentinels"), "s3");
      await expect(setDoc(ref, { a: deleteField() })).rejects.toMatchObject({
        code: "invalid-argument",
      });
    });
  });
});
