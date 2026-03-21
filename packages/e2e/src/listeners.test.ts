import {
  collection,
  type DocumentSnapshot,
  doc,
  getConnectionManager,
  onSnapshot,
  type QuerySnapshot,
  query,
  setDoc,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

function waitFor<T>(timeout = 5000): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
    setTimeout(() => rej(new Error("waitFor timed out")), timeout);
  });
  return { promise, resolve, reject };
}

describe("E2E: Real-time listeners", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    // Close WebSocket connections first to allow server to shut down
    const manager = getConnectionManager(ctx.firestore);
    manager.disconnect();
    await ctx.cleanup();
  });

  it("T10.1: document listener should receive initial snapshot", async () => {
    const ref = doc(collection(ctx.firestore, "listen-test"), "doc1");
    await setDoc(ref, { value: "initial" });

    const waiter = waitFor<DocumentSnapshot>();
    const unsubscribe = onSnapshot(ref, (snap) => {
      waiter.resolve(snap);
    });

    const snap = await waiter.promise;
    expect(snap.exists()).toBe(true);
    expect(snap.data()).toEqual({ value: "initial" });
    unsubscribe();
  });

  it("T10.2: document listener should receive updates", async () => {
    const ref = doc(collection(ctx.firestore, "listen-test"), "doc2");
    await setDoc(ref, { value: "v1" });

    let callCount = 0;
    const waiter = waitFor<DocumentSnapshot>();
    const unsubscribe = onSnapshot(ref, (snap) => {
      callCount++;
      if (callCount === 2) {
        waiter.resolve(snap);
      }
    });

    // Wait a bit for the initial snapshot to arrive, then update
    await new Promise((r) => setTimeout(r, 300));
    await setDoc(ref, { value: "v2" });

    const snap = await waiter.promise;
    expect(snap.data()).toEqual({ value: "v2" });
    unsubscribe();
  });

  it("T10.3: query listener should receive initial snapshot", async () => {
    const col = collection(ctx.firestore, "listen-q");
    await setDoc(doc(col, "q1"), { status: "active" });
    await setDoc(doc(col, "q2"), { status: "active" });

    const q = query(col, where("status", "==", "active"));
    const waiter = waitFor<QuerySnapshot>();
    const unsubscribe = onSnapshot(q, (snap) => {
      waiter.resolve(snap);
    });

    const snap = await waiter.promise;
    expect(snap.size).toBe(2);
    unsubscribe();
  });

  it("T10.4: query listener should receive document changes", async () => {
    const col = collection(ctx.firestore, "listen-changes");
    await setDoc(doc(col, "c1"), { val: 1 });

    const q = query(col);
    let callCount = 0;
    const waiter = waitFor<QuerySnapshot>();
    const unsubscribe = onSnapshot(q, (snap) => {
      callCount++;
      if (callCount === 2) {
        waiter.resolve(snap);
      }
    });

    // Wait for initial, then add a document
    await new Promise((r) => setTimeout(r, 300));
    await setDoc(doc(col, "c2"), { val: 2 });

    const snap = await waiter.promise;
    expect(snap.size).toBe(2);
    unsubscribe();
  });

  it("T10.5: unsubscribe should stop receiving updates", async () => {
    const ref = doc(collection(ctx.firestore, "listen-unsub"), "u1");
    await setDoc(ref, { value: "initial" });

    let callCount = 0;
    const unsubscribe = onSnapshot(ref, () => {
      callCount++;
    });

    // Wait for initial snapshot
    await new Promise((r) => setTimeout(r, 300));
    unsubscribe();

    const countAfterUnsub = callCount;
    await setDoc(ref, { value: "updated" });
    await new Promise((r) => setTimeout(r, 300));

    // Should not have received any more snapshots
    expect(callCount).toBe(countAfterUnsub);
  });
});
