import {
  collection,
  deleteDoc,
  disableNetwork,
  doc,
  enableNetwork,
  getFirestore,
  onSnapshot,
  orderBy,
  type QuerySnapshot,
  query,
  setDoc,
  terminate,
  updateDoc,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

interface ObservedQuery {
  ids: string[];
  changes: Array<{ type: string; id: string; oldIndex: number; newIndex: number }>;
  hasPendingWrites: boolean;
}

function observeQuery(snap: QuerySnapshot): ObservedQuery {
  return {
    ids: snap.docs.map((d) => d.id),
    changes: snap
      .docChanges()
      .map((c) => ({ type: c.type, id: c.doc.id, oldIndex: c.oldIndex, newIndex: c.newIndex })),
    hasPendingWrites: snap.metadata.hasPendingWrites,
  };
}

function waitForEvent(
  events: ObservedQuery[],
  predicate: (e: ObservedQuery) => boolean,
  timeoutMs = 5000,
) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (events.some(predicate)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout. observed: ${JSON.stringify(events)}`));
      }
    }, 10);
  });
}

describe("E2E: クエリリスナーのレイテンシ補償（D-1 / D-3）", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("マッチする書き込みが即時 added され、確定後に hasPendingWrites: false になる", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const col = collection(db, "qlc1");
      const q = query(col, where("active", "==", true), orderBy("rank"));
      const events: ObservedQuery[] = [];
      const unsubscribe = onSnapshot(q, { includeMetadataChanges: true }, (snap) =>
        events.push(observeQuery(snap)),
      );

      // 初回スナップショット（空）
      await waitForEvent(events, (e) => e.ids.length === 0);

      const write = setDoc(doc(col, "a"), { active: true, rank: 1 });

      // サーバー応答前にローカルで added が発火している
      const localEvent = events.at(-1);
      expect(localEvent).toMatchObject({ ids: ["a"], hasPendingWrites: true });
      expect(localEvent?.changes).toEqual([{ type: "added", id: "a", oldIndex: -1, newIndex: 0 }]);

      await write;
      await waitForEvent(events, (e) => e.ids.includes("a") && !e.hasPendingWrites);
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("フィルタにマッチしない書き込みでは発火しない", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const col = collection(db, "qlc2");
      const q = query(col, where("active", "==", true));
      const events: ObservedQuery[] = [];
      const unsubscribe = onSnapshot(q, (snap) => events.push(observeQuery(snap)));
      await waitForEvent(events, (e) => e.ids.length === 0);
      const count = events.length;

      await setDoc(doc(col, "inactive"), { active: false });
      await new Promise((r) => setTimeout(r, 200));

      expect(events.length).toBe(count);
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("マッチしなくなる更新で即時 removed、orderBy 位置の変更で modified になる", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const col = collection(db, "qlc3");
      await setDoc(doc(col, "a"), { active: true, rank: 1 });
      await setDoc(doc(col, "b"), { active: true, rank: 2 });

      const q = query(col, where("active", "==", true), orderBy("rank"));
      const events: ObservedQuery[] = [];
      const unsubscribe = onSnapshot(q, (snap) => events.push(observeQuery(snap)));
      await waitForEvent(events, (e) => e.ids.length === 2);

      // rank 逆転 → ローカルで並び替え（modified + newIndex）
      const w1 = updateDoc(doc(col, "a"), { rank: 3 });
      const reordered = events.at(-1);
      expect(reordered?.ids).toEqual(["b", "a"]);
      expect(reordered?.changes).toContainEqual({
        type: "modified",
        id: "a",
        oldIndex: 0,
        newIndex: 1,
      });
      await w1;

      // マッチしなくなる更新 → ローカルで removed
      const w2 = updateDoc(doc(col, "b"), { active: false });
      const removed = events.at(-1);
      expect(removed?.ids).toEqual(["a"]);
      expect(removed?.changes).toContainEqual({
        type: "removed",
        id: "b",
        oldIndex: 0,
        newIndex: -1,
      });
      await w2;
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("deleteDoc が即時 removed としてクエリ結果へ反映される", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const col = collection(db, "qlc4");
      await setDoc(doc(col, "a"), { v: 1 });

      const events: ObservedQuery[] = [];
      const unsubscribe = onSnapshot(col, (snap) => events.push(observeQuery(snap)));
      await waitForEvent(events, (e) => e.ids.length === 1);

      const write = deleteDoc(doc(col, "a"));
      expect(events.at(-1)?.ids).toEqual([]);
      expect(events.at(-1)?.changes).toContainEqual({
        type: "removed",
        id: "a",
        oldIndex: 0,
        newIndex: -1,
      });
      await write;
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("D-3: 切断中に消えたドキュメントが再接続後の差分で removed として届く", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const col = collection(db, "qlc5");
      await setDoc(doc(col, "keep"), { v: 1 });
      await setDoc(doc(col, "gone"), { v: 2 });

      const events: ObservedQuery[] = [];
      const unsubscribe = onSnapshot(col, (snap) => events.push(observeQuery(snap)));
      await waitForEvent(events, (e) => e.ids.length === 2);

      // 切断（WebSocket 切断 + 送信停止）
      await disableNetwork(db);

      // 切断中にサーバー側で削除（別クライアント相当の直接 HTTP）
      const res = await fetch(`http://localhost:${ctx.port}/docs/qlc5/gone`, { method: "DELETE" });
      expect(res.status).toBe(200);

      // 再接続 → フル再購読 → 前回結果との差分で removed が届く
      await enableNetwork(db);
      await waitForEvent(events, (e) =>
        e.changes.some((c) => c.type === "removed" && c.id === "gone"),
      );
      expect(events.at(-1)?.ids).toEqual(["keep"]);
      // 全件 added の再通知にはならない（差分のみ）
      const lastChanges = events.at(-1)?.changes ?? [];
      expect(lastChanges.filter((c) => c.type === "added" && c.id === "keep")).toHaveLength(0);
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });
});
