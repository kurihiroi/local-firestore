import {
  Bytes,
  collection,
  doc,
  GeoPoint,
  getDoc,
  setDoc,
  Timestamp,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: Data type round-trip", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("T3.1: should round-trip string, number, boolean, null", async () => {
    const ref = doc(collection(ctx.firestore, "dt-test"), "primitives");
    await setDoc(ref, {
      str: "hello",
      num: 42,
      float: 3.14,
      negative: -100,
      boolTrue: true,
      boolFalse: false,
      nothing: null,
    });

    const snap = await getDoc(ref);
    const data = snap.data() as Record<string, unknown>;
    expect(data.str).toBe("hello");
    expect(data.num).toBe(42);
    expect(data.float).toBeCloseTo(3.14);
    expect(data.negative).toBe(-100);
    expect(data.boolTrue).toBe(true);
    expect(data.boolFalse).toBe(false);
    expect(data.nothing).toBeNull();
  });

  it("T3.2: should round-trip Timestamp", async () => {
    const ref = doc(collection(ctx.firestore, "dt-test"), "timestamp");
    const ts = Timestamp.fromDate(new Date("2025-01-15T10:30:00Z"));
    await setDoc(ref, { created: ts });

    const snap = await getDoc(ref);
    const data = snap.data() as Record<string, unknown>;
    const created = data.created as { seconds: number; nanoseconds: number };
    expect(created.seconds).toBe(ts.seconds);
  });

  it("T3.3: should round-trip GeoPoint", async () => {
    const ref = doc(collection(ctx.firestore, "dt-test"), "geopoint");
    const geo = new GeoPoint(35.6762, 139.6503);
    await setDoc(ref, { location: geo });

    const snap = await getDoc(ref);
    const data = snap.data() as Record<string, unknown>;
    const location = data.location as { latitude: number; longitude: number };
    expect(location.latitude).toBeCloseTo(35.6762);
    expect(location.longitude).toBeCloseTo(139.6503);
  });

  it("T3.4: should round-trip Bytes", async () => {
    const ref = doc(collection(ctx.firestore, "dt-test"), "bytes");
    const bytes = Bytes.fromBase64String(btoa("hello binary"));
    await setDoc(ref, { payload: bytes });

    const snap = await getDoc(ref);
    const data = snap.data() as Record<string, unknown>;
    expect(data.payload).toBeDefined();
  });

  it("T3.5: should round-trip nested Map and Array", async () => {
    const ref = doc(collection(ctx.firestore, "dt-test"), "nested");
    await setDoc(ref, {
      profile: {
        name: "Alice",
        address: {
          city: "Tokyo",
          zip: "100-0001",
        },
      },
      scores: [100, 95, 88],
      matrix: [
        [1, 2],
        [3, 4],
      ],
    });

    const snap = await getDoc(ref);
    const data = snap.data() as Record<string, unknown>;
    const profile = data.profile as Record<string, unknown>;
    expect(profile.name).toBe("Alice");
    const address = profile.address as Record<string, unknown>;
    expect(address.city).toBe("Tokyo");
    expect(address.zip).toBe("100-0001");
    expect(data.scores).toEqual([100, 95, 88]);
    expect(data.matrix).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});
