import { describe, expect, it, vi } from "vitest";
import { runTransaction, Transaction } from "./transaction.js";
import { FirestoreError } from "./transport.js";
import type { CollectionReference, DocumentReference, Firestore } from "./types.js";
import { DocumentSnapshot } from "./types.js";

function createMockTransport() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    getWebSocketUrl: vi.fn().mockReturnValue("ws://localhost:8080"),
  };
}

function createMockFirestore(transport: ReturnType<typeof createMockTransport>): Firestore {
  return { type: "firestore", _transport: transport } as Firestore;
}

function createMockDocRef(firestore: Firestore, path: string): DocumentReference {
  const id = path.split("/").pop() ?? "";
  return {
    type: "document",
    id,
    path,
    parent: {} as CollectionReference,
    firestore,
    converter: null,
    _firestore: firestore,
    _converter: null,
    withConverter: (() => {}) as never,
  };
}

describe("Transaction", () => {
  it("set操作を記録する", () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    const tx = new Transaction(firestore, "tx-1");
    const ref = createMockDocRef(firestore, "users/alice");

    const result = tx.set(ref, { name: "Alice" });
    expect(result).toBe(tx); // チェーン可能
    expect(tx._getOperations()).toEqual([
      { type: "set", path: "users/alice", data: { name: "Alice" } },
    ]);
  });

  it("update操作を記録する", () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    const tx = new Transaction(firestore, "tx-1");
    const ref = createMockDocRef(firestore, "users/alice");

    const result = tx.update(ref, { age: 31 });
    expect(result).toBe(tx);
    expect(tx._getOperations()).toEqual([
      { type: "update", path: "users/alice", data: { age: 31 } },
    ]);
  });

  it("delete操作を記録する", () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    const tx = new Transaction(firestore, "tx-1");
    const ref = createMockDocRef(firestore, "users/alice");

    const result = tx.delete(ref);
    expect(result).toBe(tx);
    expect(tx._getOperations()).toEqual([{ type: "delete", path: "users/alice" }]);
  });

  it("複数の操作を記録する", () => {
    const transport = createMockTransport();
    const firestore = createMockFirestore(transport);
    const tx = new Transaction(firestore, "tx-1");
    const ref1 = createMockDocRef(firestore, "users/alice");
    const ref2 = createMockDocRef(firestore, "users/bob");

    tx.set(ref1, { name: "Alice" }).update(ref2, { age: 25 }).delete(ref1);

    expect(tx._getOperations()).toHaveLength(3);
    expect(tx._getOperations()[0].type).toBe("set");
    expect(tx._getOperations()[1].type).toBe("update");
    expect(tx._getOperations()[2].type).toBe("delete");
  });

  it("get()でドキュメントを取得する", async () => {
    const transport = createMockTransport();
    transport.post.mockResolvedValue({
      exists: true,
      data: { name: "Alice" },
      createTime: "2024-01-01T00:00:00Z",
      updateTime: "2024-01-02T00:00:00Z",
    });

    const firestore = createMockFirestore(transport);
    const tx = new Transaction(firestore, "tx-1");
    const ref = createMockDocRef(firestore, "users/alice");

    const snapshot = await tx.get(ref);

    expect(snapshot).toBeInstanceOf(DocumentSnapshot);
    expect(snapshot.exists()).toBe(true);
    expect(snapshot.data()).toEqual({ name: "Alice" });
    expect(transport.post).toHaveBeenCalledWith("/transaction/get", {
      transactionId: "tx-1",
      path: "users/alice",
    });
  });

  it("get()で存在しないドキュメントを取得する", async () => {
    const transport = createMockTransport();
    transport.post.mockResolvedValue({
      exists: false,
      data: null,
      createTime: null,
      updateTime: null,
    });

    const firestore = createMockFirestore(transport);
    const tx = new Transaction(firestore, "tx-1");
    const ref = createMockDocRef(firestore, "users/nonexistent");

    const snapshot = await tx.get(ref);
    expect(snapshot.exists()).toBe(false);
    expect(snapshot.data()).toBeUndefined();
  });
});

describe("runTransaction()", () => {
  it("トランザクションを正常に実行する", async () => {
    const transport = createMockTransport();
    transport.post
      .mockResolvedValueOnce({ transactionId: "tx-1" }) // begin
      .mockResolvedValueOnce({ success: true }); // commit

    const firestore = createMockFirestore(transport);

    const result = await runTransaction(firestore, async (tx) => {
      const ref = createMockDocRef(firestore, "users/alice");
      tx.set(ref, { name: "Alice" });
      return "done";
    });

    expect(result).toBe("done");
    expect(transport.post).toHaveBeenCalledTimes(2);
    expect(transport.post).toHaveBeenNthCalledWith(1, "/transaction/begin", {});
    expect(transport.post).toHaveBeenNthCalledWith(2, "/transaction/commit", {
      transactionId: "tx-1",
      operations: [{ type: "set", path: "users/alice", data: { name: "Alice" } }],
    });
  });

  it("ABORTEDエラー時にリトライする", async () => {
    const transport = createMockTransport();
    transport.post
      .mockResolvedValueOnce({ transactionId: "tx-1" }) // 1st begin
      .mockResolvedValueOnce({}) // 1st rollback
      .mockResolvedValueOnce({ transactionId: "tx-2" }) // 2nd begin
      .mockResolvedValueOnce({ success: true }); // 2nd commit

    const firestore = createMockFirestore(transport);
    let attempt = 0;

    const result = await runTransaction(firestore, async (_tx) => {
      attempt++;
      if (attempt === 1) {
        throw new FirestoreError("aborted", "Transaction conflict");
      }
      return "success";
    });

    expect(result).toBe("success");
    expect(attempt).toBe(2);
  });

  it("ABORTED以外のエラー時はリトライしない", async () => {
    const transport = createMockTransport();
    transport.post
      .mockResolvedValueOnce({ transactionId: "tx-1" }) // begin
      .mockResolvedValueOnce({}); // rollback

    const firestore = createMockFirestore(transport);

    await expect(
      runTransaction(firestore, async () => {
        throw new FirestoreError("permission-denied", "Not allowed");
      }),
    ).rejects.toThrow("Not allowed");
  });

  it("maxAttemptsオプションを尊重する", async () => {
    const transport = createMockTransport();
    // Each attempt: begin + rollback
    for (let i = 0; i < 6; i++) {
      transport.post.mockResolvedValueOnce({ transactionId: `tx-${i}` }); // begin
      transport.post.mockResolvedValueOnce({}); // rollback
    }

    const firestore = createMockFirestore(transport);
    let attempts = 0;

    await expect(
      runTransaction(
        firestore,
        async () => {
          attempts++;
          throw new FirestoreError("aborted", "Conflict");
        },
        { maxAttempts: 3 },
      ),
    ).rejects.toThrow("Conflict");

    expect(attempts).toBe(3);
  });
});
