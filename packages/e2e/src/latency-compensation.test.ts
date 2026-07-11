import {
  collection,
  type DocumentSnapshot,
  doc,
  getFirestore,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  terminate,
  updateDoc,
  waitForPendingWrites,
} from "@local-firestore/client";
import type { SecurityRules } from "@local-firestore/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

interface Observed {
  value: unknown;
  exists: boolean;
  hasPendingWrites: boolean;
}

function observe(snap: DocumentSnapshot): Observed {
  return {
    value: snap.data()?.v,
    exists: snap.exists(),
    hasPendingWrites: snap.metadata.hasPendingWrites,
  };
}

/** 指定条件のイベントが観測されるまで待つ */
function waitFor(events: Observed[], predicate: (e: Observed) => boolean, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (events.some(predicate)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for event. observed: ${JSON.stringify(events)}`));
      }
    }, 10);
  });
}

describe("E2E: レイテンシ補償（D-1）", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("書き込み直後（サーバー応答前）に hasPendingWrites: true で発火し、確定後に false になる", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "lc"), "d1");
      const events: Observed[] = [];

      const unsubscribe = onSnapshot(
        ref,
        { includeMetadataChanges: true },
        (snap: DocumentSnapshot) => events.push(observe(snap)),
      );

      // 初回スナップショット（exists: false）を待つ
      await waitFor(events, (e) => !e.exists);

      const countBeforeWrite = events.length;
      const write = setDoc(ref, { v: 1 });

      // setDoc の Promise 解決前（サーバー応答前）にローカルイベントが発火している
      expect(events.length).toBeGreaterThan(countBeforeWrite);
      expect(events.at(-1)).toMatchObject({ value: 1, hasPendingWrites: true });

      await write;
      // サーバー確定後に hasPendingWrites: false のイベントが届く
      await waitFor(events, (e) => e.value === 1 && !e.hasPendingWrites);
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("includeMetadataChanges なしのリスナーは metadata のみの変更で発火しない", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "lc"), "d2");
      const events: Observed[] = [];
      const unsubscribe = onSnapshot(ref, (snap: DocumentSnapshot) => events.push(observe(snap)));

      await waitFor(events, (e) => !e.exists);

      await setDoc(ref, { v: 1 });
      await waitForPendingWrites(db);
      // サーバースナップショットの反映を待つ
      await new Promise((r) => setTimeout(r, 300));

      // 期待: 初回(absent) + ローカル反映(v1, pending) の2件のみ。
      // 確定時はデータが同じため metadata のみの変更となり発火しない
      const v1Events = events.filter((e) => e.value === 1);
      expect(v1Events).toHaveLength(1);
      expect(v1Events[0].hasPendingWrites).toBe(true);
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("serverTimestamp がローカル推定値で即時反映され、確定後にサーバー時刻へ置き換わる", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "lc"), "d3");
      const timestamps: Array<{ at: unknown; pending: boolean }> = [];
      const unsubscribe = onSnapshot(ref, { includeMetadataChanges: true }, (snap) => {
        timestamps.push({
          at: snap.data()?.at,
          pending: snap.metadata.hasPendingWrites,
        });
      });

      const write = setDoc(ref, { at: serverTimestamp() });

      // ローカル推定値（クライアント時刻の Timestamp）が即時反映されている
      const localEvent = timestamps.at(-1);
      expect(localEvent?.pending).toBe(true);
      expect(localEvent?.at).toBeInstanceOf(Timestamp);
      expect(Math.abs((localEvent?.at as Timestamp).toMillis() - Date.now())).toBeLessThan(5000);

      await write;
      await waitFor(
        timestamps.map((t) => ({
          value: undefined,
          exists: true,
          hasPendingWrites: t.pending,
        })),
        () => timestamps.some((t) => !t.pending),
      );
      const confirmed = timestamps.find((t) => !t.pending);
      expect(confirmed?.at).toBeInstanceOf(Timestamp);
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("increment がキャッシュ値ベースで即時反映される", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "lc"), "d4");
      await setDoc(ref, { v: 10 });

      const events: Observed[] = [];
      const unsubscribe = onSnapshot(ref, (snap: DocumentSnapshot) => events.push(observe(snap)));
      await waitFor(events, (e) => e.value === 10);

      const { increment } = await import("@local-firestore/client");
      const write = updateDoc(ref, { v: increment(5) });
      // ローカルで 10 + 5 = 15 が即時反映される
      expect(events.at(-1)).toMatchObject({ value: 15, hasPendingWrites: true });
      await write;
      unsubscribe();
    } finally {
      await terminate(db);
    }
  });

  it("ルール拒否された書き込みはロールバックされ、Promise が reject される", async () => {
    const rules: SecurityRules = {
      rules: { locked: { read: true, write: false }, lc: { read: true, write: true } },
    };
    const ruleCtx = await startTestServer({ securityRules: rules });
    const db = getFirestore({ host: "localhost", port: ruleCtx.port });
    try {
      const ref = doc(collection(db, "locked"), "d1");
      const events: Observed[] = [];
      const unsubscribe = onSnapshot(ref, { includeMetadataChanges: true }, (snap) =>
        events.push(observe(snap)),
      );
      await waitFor(events, (e) => !e.exists);

      const write = setDoc(ref, { v: 1 });
      // ローカル反映（pending）
      expect(events.at(-1)).toMatchObject({ value: 1, hasPendingWrites: true });

      await expect(write).rejects.toMatchObject({ code: "permission-denied" });
      // ロールバック後のスナップショット（exists: false）が発火する
      await waitFor(events, (e) => !e.exists && !e.hasPendingWrites);
      expect(events.at(-1)).toMatchObject({ exists: false });
      unsubscribe();
    } finally {
      await terminate(db);
      await ruleCtx.cleanup();
    }
  });

  it("waitForPendingWrites が全書き込みの確定で解決する", async () => {
    const db = getFirestore({ host: "localhost", port: ctx.port });
    try {
      const ref = doc(collection(db, "lc"), "d5");
      const w1 = setDoc(ref, { v: 1 });
      const w2 = updateDoc(ref, { v: 2 });
      await waitForPendingWrites(db);
      await Promise.all([w1, w2]);
    } finally {
      await terminate(db);
    }
  });
});
