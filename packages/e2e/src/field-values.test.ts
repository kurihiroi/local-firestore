import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDoc,
  increment,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Field value sentinels", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T2.1: serverTimestamp() should set a server-side timestamp", async () => {
    const ref = doc(collection(ctx.firestore, "fv-test"), "ts1");
    const before = Date.now();
    await setDoc(ref, { name: "test", createdAt: serverTimestamp() });
    const after = Date.now();

    const snap = await getDoc(ref);
    const data = snap.data() as Record<string, unknown>;
    expect(data.name).toBe("test");

    const createdAt = data.createdAt as {
      __type: string;
      value: { seconds: number; nanoseconds: number };
    };
    expect(createdAt.__type).toBe("timestamp");
    const tsMillis = createdAt.value.seconds * 1000 + createdAt.value.nanoseconds / 1e6;
    expect(tsMillis).toBeGreaterThanOrEqual(before - 1000);
    expect(tsMillis).toBeLessThanOrEqual(after + 1000);
  });

  it("T2.2: increment() should atomically increment a numeric field", async () => {
    const ref = doc(collection(ctx.firestore, "fv-test"), "inc1");
    await setDoc(ref, { count: 10 });

    await updateDoc(ref, { count: increment(5) });

    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ count: 15 });
  });

  it("T2.3: arrayUnion() should add elements without duplicates", async () => {
    const ref = doc(collection(ctx.firestore, "fv-test"), "au1");
    await setDoc(ref, { tags: ["a", "b"] });

    await updateDoc(ref, { tags: arrayUnion("b", "c") });

    const snap = await getDoc(ref);
    const data = snap.data() as { tags: string[] };
    expect(data.tags).toEqual(["a", "b", "c"]);
  });

  it("T2.4: arrayRemove() should remove elements from array", async () => {
    const ref = doc(collection(ctx.firestore, "fv-test"), "ar1");
    await setDoc(ref, { tags: ["a", "b", "c", "d"] });

    await updateDoc(ref, { tags: arrayRemove("b", "d") });

    const snap = await getDoc(ref);
    const data = snap.data() as { tags: string[] };
    expect(data.tags).toEqual(["a", "c"]);
  });

  it("T2.5: deleteField() should remove a specific field", async () => {
    const ref = doc(collection(ctx.firestore, "fv-test"), "df1");
    await setDoc(ref, { name: "test", temp: "to-remove" });

    await updateDoc(ref, { temp: deleteField() });

    const snap = await getDoc(ref);
    expect(snap.data()).toEqual({ name: "test" });
  });
});
