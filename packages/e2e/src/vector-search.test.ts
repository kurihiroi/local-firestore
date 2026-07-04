import {
  collection,
  doc,
  findNearest,
  getDocs,
  query,
  setDoc,
  VectorValue,
  vector,
  where,
} from "@local-firestore/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestServer, type TestContext } from "./helpers.js";

describe("E2E: ベクトル近傍検索 (findNearest)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startTestServer();

    const items = collection(ctx.firestore, "vec-items");
    await setDoc(doc(items, "red"), {
      name: "red",
      group: "warm",
      embedding: vector([1, 0, 0]),
    });
    await setDoc(doc(items, "orange"), {
      name: "orange",
      group: "warm",
      embedding: vector([0.9, 0.3, 0]),
    });
    await setDoc(doc(items, "blue"), {
      name: "blue",
      group: "cool",
      embedding: vector([0, 0, 1]),
    });
    await setDoc(doc(items, "no-vector"), { name: "no-vector", group: "warm" });
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("距離の近い順にドキュメントを取得できる", async () => {
    const items = collection(ctx.firestore, "vec-items");
    const q = findNearest(items, {
      vectorField: "embedding",
      queryVector: [1, 0, 0],
      limit: 2,
      distanceMeasure: "EUCLIDEAN",
    });
    const snap = await getDocs(q);
    expect(snap.docs.map((d) => d.id)).toEqual(["red", "orange"]);
  });

  it("VectorValueはインスタンスとして保存・取得できる", async () => {
    const items = collection(ctx.firestore, "vec-items");
    const q = findNearest(items, {
      vectorField: "embedding",
      queryVector: vector([0, 0, 1]),
      limit: 1,
      distanceMeasure: "COSINE",
    });
    const snap = await getDocs(q);
    expect(snap.docs).toHaveLength(1);
    const data = snap.docs[0].data() as Record<string, unknown>;
    expect(data.name).toBe("blue");
    // 本家 SDK と同様、読み取り時に VectorValue インスタンスへ復元される
    expect(data.embedding).toBeInstanceOf(VectorValue);
    expect((data.embedding as VectorValue).toArray()).toEqual([0, 0, 1]);
  });

  it("whereフィルタとdistanceResultFieldを組み合わせられる", async () => {
    const items = collection(ctx.firestore, "vec-items");
    const q = findNearest(query(items, where("group", "==", "warm")), {
      vectorField: "embedding",
      queryVector: [0, 0, 1],
      limit: 10,
      distanceMeasure: "COSINE",
      distanceResultField: "distance",
    });
    const snap = await getDocs(q);
    // cool の blue とベクトルなしの no-vector は除外される
    expect(snap.docs.map((d) => d.id).sort()).toEqual(["orange", "red"]);
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>;
      expect(typeof data.distance).toBe("number");
    }
  });

  it("distanceThresholdで結果を絞り込める", async () => {
    const items = collection(ctx.firestore, "vec-items");
    const q = findNearest(items, {
      vectorField: "embedding",
      queryVector: [1, 0, 0],
      limit: 10,
      distanceMeasure: "EUCLIDEAN",
      distanceThreshold: 0.5,
    });
    const snap = await getDocs(q);
    expect(snap.docs.map((d) => d.id)).toEqual(["red", "orange"]);
  });
});
