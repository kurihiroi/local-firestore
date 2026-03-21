import { describe, expect, it, vi } from "vitest";
import { HttpTransport } from "./transport.js";
import { WriteQueue, type WriteQueueEvent } from "./write-queue.js";

/** Mock HttpTransport */
function createMockTransport() {
  const transport = new HttpTransport("localhost", 8080);
  const putSpy = vi.fn().mockResolvedValue({ success: true });
  const patchSpy = vi.fn().mockResolvedValue({ success: true });
  const deleteSpy = vi.fn().mockResolvedValue({ success: true });
  const postSpy = vi.fn().mockResolvedValue({ path: "col/newId", documentId: "newId" });

  // Override methods
  transport.put = putSpy;
  transport.patch = patchSpy;
  transport.delete = deleteSpy;
  transport.post = postSpy;

  return { transport, putSpy, patchSpy, deleteSpy, postSpy };
}

describe("WriteQueue", () => {
  describe("enqueue", () => {
    it("should add write to queue", () => {
      const { transport } = createMockTransport();
      const queue = new WriteQueue(transport);

      queue.enqueue("set", "users/u1", { name: "Alice" });
      expect(queue.size).toBe(1);
      expect(queue.pendingWrites[0].type).toBe("set");
      expect(queue.pendingWrites[0].path).toBe("users/u1");
    });

    it("should emit enqueued event", () => {
      const { transport } = createMockTransport();
      const queue = new WriteQueue(transport);
      const events: WriteQueueEvent[] = [];
      queue.addListener((event) => events.push(event));

      queue.enqueue("set", "users/u1", { name: "Alice" });
      expect(events).toEqual(["enqueued"]);
    });
  });

  describe("flush", () => {
    it("should execute set operations", async () => {
      const { transport, putSpy } = createMockTransport();
      const queue = new WriteQueue(transport);

      queue.enqueue("set", "users/u1", { name: "Alice" });
      await queue.flush();

      expect(putSpy).toHaveBeenCalledWith("/docs/users/u1", {
        data: { name: "Alice" },
        options: undefined,
      });
      expect(queue.size).toBe(0);
    });

    it("should execute update operations", async () => {
      const { transport, patchSpy } = createMockTransport();
      const queue = new WriteQueue(transport);

      queue.enqueue("update", "users/u1", { name: "Bob" });
      await queue.flush();

      expect(patchSpy).toHaveBeenCalledWith("/docs/users/u1", { data: { name: "Bob" } });
    });

    it("should execute delete operations", async () => {
      const { transport, deleteSpy } = createMockTransport();
      const queue = new WriteQueue(transport);

      queue.enqueue("delete", "users/u1");
      await queue.flush();

      expect(deleteSpy).toHaveBeenCalledWith("/docs/users/u1");
    });

    it("should execute add operations", async () => {
      const { transport, postSpy } = createMockTransport();
      const queue = new WriteQueue(transport);

      queue.enqueue("add", "users", { name: "Charlie" });
      await queue.flush();

      expect(postSpy).toHaveBeenCalledWith("/docs", {
        collectionPath: "users",
        data: { name: "Charlie" },
      });
    });

    it("should execute writes in order", async () => {
      const { transport, putSpy, deleteSpy } = createMockTransport();
      const queue = new WriteQueue(transport);
      const order: string[] = [];

      putSpy.mockImplementation(async () => {
        order.push("put");
        return { success: true };
      });
      deleteSpy.mockImplementation(async () => {
        order.push("delete");
        return { success: true };
      });

      queue.enqueue("set", "users/u1", { name: "Alice" });
      queue.enqueue("delete", "users/u2");
      await queue.flush();

      expect(order).toEqual(["put", "delete"]);
      expect(queue.size).toBe(0);
    });

    it("should stop on error and keep remaining writes", async () => {
      const { transport, putSpy } = createMockTransport();
      const queue = new WriteQueue(transport);

      putSpy.mockRejectedValueOnce(new Error("Network error"));

      queue.enqueue("set", "users/u1", { name: "Alice" });
      queue.enqueue("set", "users/u2", { name: "Bob" });
      await queue.flush();

      expect(queue.size).toBe(2);
      expect(queue.pendingWrites[0].retryCount).toBe(1);
    });

    it("should emit flushing and flushed events", async () => {
      const { transport } = createMockTransport();
      const queue = new WriteQueue(transport);
      const events: WriteQueueEvent[] = [];
      queue.addListener((event) => events.push(event));

      queue.enqueue("set", "users/u1", { name: "Alice" });
      await queue.flush();

      expect(events).toEqual(["enqueued", "flushing", "flushed"]);
    });

    it("should emit error event on failure", async () => {
      const { transport, putSpy } = createMockTransport();
      const queue = new WriteQueue(transport);
      const events: WriteQueueEvent[] = [];
      queue.addListener((event) => events.push(event));

      putSpy.mockRejectedValueOnce(new Error("fail"));
      queue.enqueue("set", "users/u1", { name: "Alice" });
      await queue.flush();

      expect(events).toContain("error");
    });

    it("should not flush if already flushing", async () => {
      const { transport, putSpy } = createMockTransport();
      const queue = new WriteQueue(transport);
      let callCount = 0;

      putSpy.mockImplementation(async () => {
        callCount++;
        return { success: true };
      });

      queue.enqueue("set", "users/u1", { name: "Alice" });
      // Start two flushes simultaneously
      const p1 = queue.flush();
      const p2 = queue.flush();
      await Promise.all([p1, p2]);

      expect(callCount).toBe(1);
    });

    it("should do nothing when queue is empty", async () => {
      const { transport, putSpy } = createMockTransport();
      const queue = new WriteQueue(transport);
      await queue.flush();
      expect(putSpy).not.toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should clear the queue", () => {
      const { transport } = createMockTransport();
      const queue = new WriteQueue(transport);

      queue.enqueue("set", "users/u1", { name: "Alice" });
      queue.enqueue("set", "users/u2", { name: "Bob" });
      queue.clear();

      expect(queue.size).toBe(0);
    });
  });

  describe("listener", () => {
    it("should allow removing listeners", () => {
      const { transport } = createMockTransport();
      const queue = new WriteQueue(transport);
      const events: WriteQueueEvent[] = [];
      const unsub = queue.addListener((event) => events.push(event));

      queue.enqueue("set", "users/u1", { name: "Alice" });
      unsub();
      queue.enqueue("set", "users/u2", { name: "Bob" });

      expect(events).toEqual(["enqueued"]);
    });
  });
});
