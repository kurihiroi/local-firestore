import { describe, expect, it, vi } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentService } from "./document.js";
import { ListenerManager } from "./listener-manager.js";
import { QueryService } from "./query.js";

/** テスト用のモックWebSocket */
function createMockWs() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as import("ws").WebSocket;
}

function setupTestEnv() {
  const db = createDatabase(":memory:");
  const repo = new DocumentRepository(db);
  const docService = new DocumentService(repo);
  const queryService = new QueryService(db);
  const manager = new ListenerManager(queryService);

  const getDoc = (path: string) => docService.getDocument(path);

  return { db, docService, queryService, manager, getDoc };
}

describe("ListenerManager", () => {
  describe("ドキュメントリスナー", () => {
    it("登録時に初回スナップショットが送信される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      // ドキュメントを作成
      docService.setDocument("users/alice", { name: "Alice" });

      manager.subscribeDoc(ws, "sub1", "users/alice", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
      expect(msg.type).toBe("doc_snapshot");
      expect(msg.subscriptionId).toBe("sub1");
      expect(msg.exists).toBe(true);
      expect(msg.data).toEqual({ name: "Alice" });
    });

    it("存在しないドキュメントでも初回スナップショットが送信される（exists: false）", () => {
      const { manager, getDoc } = setupTestEnv();
      const ws = createMockWs();

      manager.subscribeDoc(ws, "sub1", "users/unknown", getDoc);

      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
      expect(msg.exists).toBe(false);
      expect(msg.data).toBeNull();
    });

    it("ドキュメント変更時にスナップショットが送信される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("users/alice", { name: "Alice" });
      manager.subscribeDoc(ws, "sub1", "users/alice", getDoc);

      // ドキュメントを更新
      docService.setDocument("users/alice", { name: "Alice Updated" });
      manager.notifyChange("users/alice", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(2);
      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string);
      expect(msg.data).toEqual({ name: "Alice Updated" });
    });

    it("無関係なドキュメントの変更では通知されない", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("users/alice", { name: "Alice" });
      manager.subscribeDoc(ws, "sub1", "users/alice", getDoc);

      docService.setDocument("users/bob", { name: "Bob" });
      manager.notifyChange("users/bob", getDoc);

      // 初回スナップショットの1回のみ
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    it("unsubscribe後は通知されない", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("users/alice", { name: "Alice" });
      manager.subscribeDoc(ws, "sub1", "users/alice", getDoc);

      manager.unsubscribe("sub1");

      docService.setDocument("users/alice", { name: "Alice Updated" });
      manager.notifyChange("users/alice", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(1); // 初回のみ
    });

    it("ドキュメント削除時にexists: falseが送信される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("users/alice", { name: "Alice" });
      manager.subscribeDoc(ws, "sub1", "users/alice", getDoc);

      docService.deleteDocument("users/alice");
      manager.notifyChange("users/alice", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(2);
      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string);
      expect(msg.exists).toBe(false);
      expect(msg.data).toBeNull();
    });
  });

  describe("クエリリスナー", () => {
    it("登録時に初回スナップショットが送信される（全ドキュメントがadded）", () => {
      const { manager, docService } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("tasks/1", { title: "Task 1", done: false });
      docService.setDocument("tasks/2", { title: "Task 2", done: true });

      manager.subscribeQuery(ws, "sub1", "tasks", false, []);

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
      expect(msg.type).toBe("query_snapshot");
      expect(msg.docs).toHaveLength(2);
      expect(msg.changes).toHaveLength(2);
      expect(msg.changes[0].type).toBe("added");
      expect(msg.changes[1].type).toBe("added");
    });

    it("ドキュメント追加時にaddedの変更が通知される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("tasks/1", { title: "Task 1" });
      manager.subscribeQuery(ws, "sub1", "tasks", false, []);

      // 新しいドキュメントを追加
      docService.setDocument("tasks/2", { title: "Task 2" });
      manager.notifyChange("tasks/2", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(2);
      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string);
      expect(msg.docs).toHaveLength(2);
      const addedChange = msg.changes.find((c: { type: string }) => c.type === "added");
      expect(addedChange).toBeDefined();
      expect(addedChange.path).toBe("tasks/2");
    });

    it("ドキュメント更新時にmodifiedの変更が通知される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("tasks/1", { title: "Task 1" });
      manager.subscribeQuery(ws, "sub1", "tasks", false, []);

      // ドキュメントを更新
      docService.setDocument("tasks/1", { title: "Task 1 Updated" });
      manager.notifyChange("tasks/1", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(2);
      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string);
      const modifiedChange = msg.changes.find((c: { type: string }) => c.type === "modified");
      expect(modifiedChange).toBeDefined();
      expect(modifiedChange.path).toBe("tasks/1");
    });

    it("ドキュメント削除時にremovedの変更が通知される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("tasks/1", { title: "Task 1" });
      docService.setDocument("tasks/2", { title: "Task 2" });
      manager.subscribeQuery(ws, "sub1", "tasks", false, []);

      // ドキュメントを削除
      docService.deleteDocument("tasks/1");
      manager.notifyChange("tasks/1", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(2);
      const msg = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string);
      expect(msg.docs).toHaveLength(1);
      const removedChange = msg.changes.find((c: { type: string }) => c.type === "removed");
      expect(removedChange).toBeDefined();
      expect(removedChange.path).toBe("tasks/1");
    });

    it("whereフィルタ付きクエリで条件に合うドキュメントのみ通知される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("tasks/1", { title: "Task 1", done: false });
      manager.subscribeQuery(ws, "sub1", "tasks", false, [
        { type: "where", fieldPath: "done", op: "==", value: true },
      ]);

      // 初回は条件に合うドキュメントがない
      const msg0 = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
      expect(msg0.docs).toHaveLength(0);

      // 条件に合うドキュメントを追加
      docService.setDocument("tasks/2", { title: "Task 2", done: true });
      manager.notifyChange("tasks/2", getDoc);

      expect(ws.send).toHaveBeenCalledTimes(2);
      const msg1 = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0] as string);
      expect(msg1.docs).toHaveLength(1);
      expect(msg1.docs[0].path).toBe("tasks/2");
    });

    it("別のコレクションの変更では通知されない", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      manager.subscribeQuery(ws, "sub1", "tasks", false, []);

      docService.setDocument("users/alice", { name: "Alice" });
      manager.notifyChange("users/alice", getDoc);

      // 初回のみ
      expect(ws.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("接続管理", () => {
    it("removeConnectionで全サブスクリプションが解除される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws = createMockWs();

      docService.setDocument("users/alice", { name: "Alice" });
      manager.subscribeDoc(ws, "sub1", "users/alice", getDoc);
      manager.subscribeDoc(ws, "sub2", "users/alice", getDoc);

      expect(manager.size).toBe(2);

      manager.removeConnection(ws);
      expect(manager.size).toBe(0);
    });

    it("複数のクライアントにそれぞれ通知される", () => {
      const { manager, docService, getDoc } = setupTestEnv();
      const ws1 = createMockWs();
      const ws2 = createMockWs();

      docService.setDocument("users/alice", { name: "Alice" });
      manager.subscribeDoc(ws1, "sub1", "users/alice", getDoc);
      manager.subscribeDoc(ws2, "sub2", "users/alice", getDoc);

      docService.setDocument("users/alice", { name: "Alice Updated" });
      manager.notifyChange("users/alice", getDoc);

      // 各WebSocketに初回 + 変更通知 = 2回
      expect(ws1.send).toHaveBeenCalledTimes(2);
      expect(ws2.send).toHaveBeenCalledTimes(2);
    });
  });
});
