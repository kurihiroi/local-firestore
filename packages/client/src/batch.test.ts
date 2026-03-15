import { describe, expect, it } from "vitest";
import { WriteBatch, writeBatch } from "./batch.js";
import { getFirestore } from "./firestore.js";
import { doc } from "./references.js";

describe("writeBatch", () => {
  const db = getFirestore();

  it("WriteBatchインスタンスを返す", () => {
    const batch = writeBatch(db);
    expect(batch).toBeInstanceOf(WriteBatch);
  });

  it("set / update / delete がチェーンできる", () => {
    const batch = writeBatch(db);
    const ref1 = doc(db, "users/alice");
    const ref2 = doc(db, "users/bob");

    const result = batch.set(ref1, { name: "Alice" }).update(ref2, { age: 30 }).delete(ref1);

    expect(result).toBe(batch);
  });
});
