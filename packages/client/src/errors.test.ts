import { describe, expect, it } from "vitest";
import { WriteBatch } from "./batch.js";
import { getFirestore } from "./firestore.js";
import { collection, doc } from "./references.js";
import { FirestoreError } from "./transport.js";

describe("FirestoreError", () => {
  it("code と message を保持する", () => {
    const error = new FirestoreError("not-found", "Document not found");
    expect(error.code).toBe("not-found");
    expect(error.message).toBe("Document not found");
    expect(error.name).toBe("FirestoreError");
  });

  it("Error を継承している", () => {
    const error = new FirestoreError("invalid-argument", "Bad input");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FirestoreError);
  });

  it("すべてのエラーコードを受け付ける", () => {
    const codes = [
      "cancelled",
      "unknown",
      "invalid-argument",
      "deadline-exceeded",
      "not-found",
      "already-exists",
      "permission-denied",
      "resource-exhausted",
      "failed-precondition",
      "aborted",
      "out-of-range",
      "unimplemented",
      "internal",
      "unavailable",
      "data-loss",
      "unauthenticated",
    ] as const;

    for (const code of codes) {
      const error = new FirestoreError(code, `Error: ${code}`);
      expect(error.code).toBe(code);
    }
  });
});

describe("クライアント側バリデーションエラー", () => {
  const db = getFirestore();

  it("doc() で不正なパスを渡すと FirestoreError(invalid-argument) を投げる", () => {
    try {
      doc(db, "users");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FirestoreError);
      expect((e as FirestoreError).code).toBe("invalid-argument");
    }
  });

  it("collection() で不正なパスを渡すと FirestoreError(invalid-argument) を投げる", () => {
    try {
      collection(db, "users/alice");
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FirestoreError);
      expect((e as FirestoreError).code).toBe("invalid-argument");
    }
  });

  it("WriteBatch をcommit後に操作すると FirestoreError(failed-precondition) を投げる", () => {
    const batch = new WriteBatch(db);
    // commitを呼ぶ（サーバー接続がないのでエラーになるが、committedフラグは立つ）
    batch.commit().catch(() => {});

    // フラグが立った後の操作
    try {
      batch.set(doc(db, "users/alice"), { name: "Alice" });
      expect.fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FirestoreError);
      expect((e as FirestoreError).code).toBe("failed-precondition");
    }
  });
});
