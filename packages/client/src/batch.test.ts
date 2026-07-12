import { describe, expect, it, vi } from "vitest";
import { WriteBatch, writeBatch } from "./batch.js";
import { getFirestore } from "./firestore.js";
import { doc } from "./references.js";
import { FirestoreError } from "./transport.js";
import type { Firestore } from "./types.js";

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

  it("set の merge オプションと update の可変長形式が commit で送信される", async () => {
    const transport = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ success: true, writeResults: [] }),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      getWebSocketUrl: vi.fn(),
    };
    const mockDb = { type: "firestore", _transport: transport } as unknown as Firestore;

    const batch = writeBatch(mockDb);
    batch.set(doc(mockDb, "users/alice"), { age: 31 }, { merge: true });
    batch.update(doc(mockDb, "users/bob"), "age", 25, "profile.city", "Tokyo");
    await batch.commit();

    expect(transport.post).toHaveBeenCalledWith("/batch", {
      operations: [
        { type: "set", path: "users/alice", data: { age: 31 }, options: { merge: true } },
        {
          type: "update",
          path: "users/bob",
          data: { age: 25, "profile.city": "Tokyo" },
          options: undefined,
        },
      ],
    });
  });
});
