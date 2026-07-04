import {
  collection,
  doc,
  type Firestore,
  getConnectionManager,
  getDoc,
  getDocs,
  onSnapshot,
  type QuerySnapshot,
  setDoc,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: マルチデータベース", () => {
  let ctx: TestContext;
  const createdFirestores: Firestore[] = [];

  const createFirestore = (databaseId: string): Firestore => {
    const firestore = ctx.createFirestore(databaseId);
    createdFirestores.push(firestore);
    return firestore;
  };

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    // サーバーを終了できるよう、先に全WebSocket接続を切断する
    for (const firestore of createdFirestores) {
      getConnectionManager(firestore).disconnect();
    }
    getConnectionManager(ctx.firestore).disconnect();
    await ctx.cleanup();
  });

  it("データベースごとにドキュメントが分離される", async () => {
    const defaultDb = ctx.firestore;
    const db1 = createFirestore("db1");
    const db2 = createFirestore("db2");

    await setDoc(doc(collection(db1, "users"), "alice"), { name: "Alice in db1" });
    await setDoc(doc(collection(db2, "users"), "alice"), { name: "Alice in db2" });

    const snapDb1 = await getDoc(doc(collection(db1, "users"), "alice"));
    const snapDb2 = await getDoc(doc(collection(db2, "users"), "alice"));
    const snapDefault = await getDoc(doc(collection(defaultDb, "users"), "alice"));

    expect(snapDb1.exists()).toBe(true);
    expect((snapDb1.data() as { name: string }).name).toBe("Alice in db1");
    expect(snapDb2.exists()).toBe(true);
    expect((snapDb2.data() as { name: string }).name).toBe("Alice in db2");
    expect(snapDefault.exists()).toBe(false);
  });

  it("データベースごとにクエリを実行できる", async () => {
    const db1 = createFirestore("query-db1");
    const db2 = createFirestore("query-db2");

    await setDoc(doc(collection(db1, "items"), "a"), { price: 100 });
    await setDoc(doc(collection(db1, "items"), "b"), { price: 200 });
    await setDoc(doc(collection(db2, "items"), "c"), { price: 300 });

    const snap1 = await getDocs(collection(db1, "items"));
    const snap2 = await getDocs(collection(db2, "items"));

    expect(snap1.docs).toHaveLength(2);
    expect(snap2.docs).toHaveLength(1);
    expect(snap2.docs[0].id).toBe("c");
  });

  it("非デフォルトデータベースでリアルタイムリスナーが動作する", async () => {
    const db1 = createFirestore("listener-db");
    const itemsRef = collection(db1, "watched");

    const snapshots: QuerySnapshot[] = [];
    const unsubscribe = onSnapshot(itemsRef, (snap) => {
      snapshots.push(snap);
    });

    try {
      // 初回スナップショット（空）を待つ
      await waitFor(() => snapshots.length >= 1);
      expect(snapshots[0].size).toBe(0);

      await setDoc(doc(itemsRef, "x"), { value: 1 });
      await waitFor(() => snapshots.length >= 2);
      const latest = snapshots[snapshots.length - 1];
      expect(latest.size).toBe(1);
      expect(latest.docs[0].id).toBe("x");
    } finally {
      unsubscribe();
    }
  });

  it("リスナーもデータベース間で分離される", async () => {
    const dbA = createFirestore("iso-a");
    const dbB = createFirestore("iso-b");

    const snapshotsA: QuerySnapshot[] = [];
    const unsubscribe = onSnapshot(collection(dbA, "iso-items"), (snap) => {
      snapshotsA.push(snap);
    });

    try {
      await waitFor(() => snapshotsA.length >= 1);
      const countBefore = snapshotsA.length;

      // dbB への書き込みは dbA のリスナーに通知されない
      await setDoc(doc(collection(dbB, "iso-items"), "y"), { value: 2 });
      await delay(300);
      expect(snapshotsA.length).toBe(countBefore);
      expect(snapshotsA[snapshotsA.length - 1].size).toBe(0);
    } finally {
      unsubscribe();
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await delay(20);
  }
}
