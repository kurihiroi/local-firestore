import { describe, expect, it } from "vitest";
import { WriteBatch, writeBatch } from "./batch.js";
import { getFirestore } from "./firestore.js";
import { doc } from "./references.js";
import { FirestoreError } from "./transport.js";

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

  it("500 オペレーション超で invalid-argument エラーになる", () => {
    const batch = writeBatch(db);
    for (let i = 0; i < 500; i++) {
      batch.set(doc(db, `users/u${i}`), { i });
    }
    expect(() => batch.set(doc(db, "users/over"), { i: 500 })).toThrow(FirestoreError);
    try {
      batch.delete(doc(db, "users/over"));
      expect.unreachable();
    } catch (e) {
      expect((e as FirestoreError).code).toBe("invalid-argument");
    }
  });
});
