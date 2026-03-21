import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager, type ConnectionState, getConnectionManager } from "./connection.js";
import { HttpTransport } from "./transport.js";
import type { Firestore } from "./types.js";

/** Mock WebSocket */
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sentMessages: string[] = [];
  private eventListeners: Map<string, Array<{ handler: () => void; once: boolean }>> = new Map();

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  addEventListener(event: string, handler: () => void, options?: { once?: boolean }): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push({ handler, once: options?.once ?? false });
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
    const listeners = this.eventListeners.get("open") ?? [];
    for (const l of listeners) {
      l.handler();
    }
    this.eventListeners.set(
      "open",
      listeners.filter((l) => !l.once),
    );
  }

  simulateClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }

  static latest(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }
}

function createMockFirestore(): Firestore {
  return {
    type: "firestore",
    _transport: new HttpTransport("localhost", 8080),
  };
}

describe("ConnectionManager", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  describe("connect", () => {
    it("should create a WebSocket connection", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      manager.connect();

      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("should set state to connected on open", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      manager.connect();

      MockWebSocket.latest().simulateOpen();
      expect(manager.getState()).toBe("connected");
    });

    it("should not create duplicate connections", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      manager.connect();
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe("state listeners", () => {
    it("should notify state listeners on state change", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      const states: ConnectionState[] = [];
      manager.addStateListener((s) => states.push(s));

      manager.connect();
      MockWebSocket.latest().simulateOpen();

      expect(states).toEqual(["connected"]);
    });

    it("should allow removing state listeners", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      const states: ConnectionState[] = [];
      const unsub = manager.addStateListener((s) => states.push(s));

      manager.connect();
      MockWebSocket.latest().simulateOpen();
      unsub();

      MockWebSocket.latest().simulateClose();
      // "disconnected" and "reconnecting" should not appear since we unsubscribed
      expect(states).toEqual(["connected"]);
    });
  });

  describe("reconnection", () => {
    it("should schedule reconnection on close", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      MockWebSocket.latest().simulateClose();
      expect(manager.getState()).toBe("reconnecting");
    });

    it("should reconnect with exponential backoff", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore, {
        initialDelay: 100,
        multiplier: 2,
      });
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      // First disconnect - schedules reconnect at 100ms (100 * 2^0)
      MockWebSocket.latest().simulateClose();
      expect(manager.getState()).toBe("reconnecting");

      // Don't open the reconnected WS - simulating ongoing failure
      // This means retryCount is NOT reset
      vi.advanceTimersByTime(100);
      // WS#2 created but not opened - close it to trigger second retry
      MockWebSocket.latest().simulateClose();

      // Second retry at 200ms (100 * 2^1) because retryCount=1
      const countBeforeSecondRetry = MockWebSocket.instances.length;
      vi.advanceTimersByTime(199);
      expect(MockWebSocket.instances.length).toBe(countBeforeSecondRetry);

      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances.length).toBe(countBeforeSecondRetry + 1);
    });

    it("should respect maxRetries", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore, {
        maxRetries: 2,
        initialDelay: 100,
        multiplier: 2,
      });
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      // First disconnect - don't open, simulating persistent failure (retry 1/2)
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(100);
      // WS#2 created but fails
      MockWebSocket.latest().simulateClose();

      // Second retry (retry 2/2)
      vi.advanceTimersByTime(200);
      // WS#3 created but fails
      MockWebSocket.latest().simulateClose();

      // No more retries (maxRetries = 2 exhausted)
      const countAfterExhausted = MockWebSocket.instances.length;
      vi.advanceTimersByTime(10000);
      expect(MockWebSocket.instances.length).toBe(countAfterExhausted);
    });

    it("should reset retry count on successful connection", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore, {
        maxRetries: 2,
        initialDelay: 100,
        multiplier: 2,
      });
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      // Use up one retry
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(100);
      MockWebSocket.latest().simulateOpen();

      // Disconnect again - retryCount should have been reset
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(100); // Back to initial delay
      expect(MockWebSocket.instances).toHaveLength(3);
    });
  });

  describe("subscription re-registration", () => {
    it("should re-register subscriptions on reconnect", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore, { initialDelay: 100 });
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      // Register a subscription
      const subMsg = JSON.stringify({
        type: "subscribe_doc",
        subscriptionId: "sub1",
        path: "users/u1",
      });
      manager.registerSubscription("sub1", subMsg);

      // Verify it was sent
      expect(MockWebSocket.latest().sentMessages).toContain(subMsg);

      // Disconnect and reconnect
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(100);
      MockWebSocket.latest().simulateOpen();

      // Subscription should be re-sent
      const latestWs = MockWebSocket.latest();
      expect(latestWs.sentMessages).toContain(subMsg);
    });

    it("should not re-register removed subscriptions", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore, { initialDelay: 100 });
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      const subMsg = JSON.stringify({
        type: "subscribe_doc",
        subscriptionId: "sub1",
        path: "users/u1",
      });
      manager.registerSubscription("sub1", subMsg);
      manager.removeSubscription("sub1");

      // Disconnect and reconnect
      MockWebSocket.latest().simulateClose();
      vi.advanceTimersByTime(100);
      MockWebSocket.latest().simulateOpen();

      // Subscription should NOT be re-sent
      expect(MockWebSocket.latest().sentMessages).not.toContain(subMsg);
    });
  });

  describe("message handling", () => {
    it("should forward messages to handler", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      const messages: unknown[] = [];
      manager.setMessageHandler((msg) => messages.push(msg));

      manager.connect();
      MockWebSocket.latest().simulateOpen();

      const msg = JSON.stringify({
        type: "doc_snapshot",
        subscriptionId: "sub1",
        exists: true,
        path: "users/u1",
        data: { name: "Alice" },
        createTime: "2026-01-01T00:00:00Z",
        updateTime: "2026-01-01T00:00:00Z",
      });
      MockWebSocket.latest().simulateMessage(msg);

      expect(messages).toHaveLength(1);
    });
  });

  describe("disconnect", () => {
    it("should close the WebSocket and stop retrying", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore, { initialDelay: 100 });
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      manager.disconnect();
      expect(manager.getState()).toBe("disconnected");

      // Should not reconnect
      vi.advanceTimersByTime(10000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe("dispose", () => {
    it("should clear all subscriptions and listeners", () => {
      const firestore = createMockFirestore();
      const manager = new ConnectionManager(firestore);
      manager.connect();
      MockWebSocket.latest().simulateOpen();

      manager.registerSubscription("sub1", "msg1");
      manager.addStateListener(() => {});

      manager.dispose();
      expect(manager.subscriptionCount).toBe(0);
      expect(manager.getState()).toBe("disconnected");
    });
  });
});

describe("getConnectionManager", () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    MockWebSocket.reset();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("should return the same manager for the same firestore instance", () => {
    const firestore = createMockFirestore();
    const manager1 = getConnectionManager(firestore);
    const manager2 = getConnectionManager(firestore);
    expect(manager1).toBe(manager2);
  });

  it("should return different managers for different firestore instances", () => {
    const firestore1 = createMockFirestore();
    const firestore2 = createMockFirestore();
    const manager1 = getConnectionManager(firestore1);
    const manager2 = getConnectionManager(firestore2);
    expect(manager1).not.toBe(manager2);
  });
});
