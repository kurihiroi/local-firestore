import {
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  getFirestore,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  terminate,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: キャッシュ読み取り API（D-2）", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("getDoc で観測済みのドキュメントを getDocFromCache で読める（fromCache: true）", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "cr1"), "d1");
      await setDoc(ref, { v: 1 });
      await getDoc(ref); // キャッシュを温める

      const snap = await getDocFromCache(ref);
      expect(snap.exists()).toBe(true);
      expect(snap.data()).toEqual({ v: 1 });
      expect(snap.metadata.fromCache).toBe(true);
      expect(snap.metadata.hasPendingWrites).toBe(false);
    } finally {
      await terminate(db);
    }
  });

  it("キャッシュ未命中は unavailable エラーになる", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "cr1"), "never-seen");
      await expect(getDocFromCache(ref)).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await terminate(db);
    }
  });

  it("pending write がローカルビューとして読める（オフライン書き込み）", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "cr2"), "d1");
      await disableNetwork(db);
      const write = setDoc(ref, { v: 42 });

      const snap = await getDocFromCache(ref);
      expect(snap.exists()).toBe(true);
      expect(snap.data()).toEqual({ v: 42 });
      expect(snap.metadata.hasPendingWrites).toBe(true);
      expect(snap.metadata.fromCache).toBe(true);

      await enableNetwork(db);
      await write;
    } finally {
      await terminate(db);
    }
  });

  it("存在しないことを観測済みのドキュメントは exists: false を返す", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "cr3"), "absent");
      await getDoc(ref); // exists: false を観測

      const snap = await getDocFromCache(ref);
      expect(snap.exists()).toBe(false);
      expect(snap.metadata.fromCache).toBe(true);
    } finally {
      await terminate(db);
    }
  });

  it("getDocsFromCache がキャッシュ済みドキュメントへクエリ制約を適用する", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const col = collection(db, "cr4");
      await setDoc(doc(col, "a"), { rank: 2, active: true });
      await setDoc(doc(col, "b"), { rank: 1, active: true });
      await setDoc(doc(col, "c"), { rank: 3, active: false });

      // リスナー経由でキャッシュを温める
      await new Promise<void>((resolve) => {
        const unsubscribe = onSnapshot(col, (snap) => {
          if (snap.size === 3) {
            unsubscribe();
            resolve();
          }
        });
      });

      const snap = await getDocsFromCache(query(col, where("active", "==", true), orderBy("rank")));
      expect(snap.docs.map((d) => d.id)).toEqual(["b", "a"]);
      expect(snap.metadata.fromCache).toBe(true);
    } finally {
      await terminate(db);
    }
  });

  it("オフライン中の書き込みが getDocsFromCache の結果へ反映される", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const col = collection(db, "cr5");
      await setDoc(doc(col, "a"), { v: 1 });
      await getDocs(query(col)); // キャッシュを温める

      await disableNetwork(db);
      const write = setDoc(doc(col, "b"), { v: 2 });

      const snap = await getDocsFromCache(query(col));
      expect(snap.docs.map((d) => d.id)).toEqual(["a", "b"]);
      expect(snap.metadata.hasPendingWrites).toBe(true);
      const pendingDoc = snap.docs.find((d) => d.id === "b");
      expect(pendingDoc?.metadata.hasPendingWrites).toBe(true);

      await enableNetwork(db);
      await write;
    } finally {
      await terminate(db);
    }
  });
});
