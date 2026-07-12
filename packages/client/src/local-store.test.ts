import { describe, expect, it, vi } from "vitest";
import { LocalStore } from "./local-store.js";
import { FirestoreError } from "./transport.js";
import type { Firestore } from "./types.js";

function createMockTransport() {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ success: true, writeResults: [] }),
    put: vi.fn().mockResolvedValue({ success: true, updateTime: "2026-01-01T00:00:00.000001Z" }),
    patch: vi.fn().mockResolvedValue({ success: true, updateTime: "2026-01-01T00:00:00.000001Z" }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    getWebSocketUrl: vi.fn(),
  };
}

function setup() {
  const transport = createMockTransport();
  const firestore = { type: "firestore", _transport: transport } as unknown as Firestore;
  const store = new LocalStore(firestore);
  return { transport, firestore, store };
}

describe("LocalStore", () => {
  describe("composeDocument（ローカルビュー合成）", () => {
    it("リモート未観測かつ mutation なしでは null（状態不明）を返す", () => {
      const { store } = setup();
      expect(store.composeDocument("users/unknown")).toBeNull();
    });

    it("set mutation はリモート未観測でも状態を確定させる（fromCache: true）", () => {
      const { store } = setup();
      void store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]).catch(() => {});
      expect(store.composeDocument("users/a")).toMatchObject({
        exists: true,
        data: { v: 1 },
        hasPendingWrites: true,
        fromCache: true,
      });
    });

    it("リモート確定値に mutation を batchId 順で重ねる", () => {
      const { store } = setup();
      store.applyRemoteDoc("users/a", true, { v: 1, keep: true }, "t1", "t1");
      void store.enqueue([{ type: "update", path: "users/a", data: { v: 2 } }]).catch(() => {});
      void store.enqueue([{ type: "update", path: "users/a", data: { v: 3 } }]).catch(() => {});
      expect(store.composeDocument("users/a")).toMatchObject({
        exists: true,
        data: { v: 3, keep: true },
        hasPendingWrites: true,
        fromCache: false,
      });
    });

    it("delete mutation で exists: false になる", () => {
      const { store } = setup();
      store.applyRemoteDoc("users/a", true, { v: 1 }, "t1", "t1");
      void store.enqueue([{ type: "delete", path: "users/a" }]).catch(() => {});
      expect(store.composeDocument("users/a")).toMatchObject({
        exists: false,
        data: null,
        hasPendingWrites: true,
      });
    });

    it("ベース不明の update は状態不明のまま（null）", () => {
      const { store } = setup();
      void store.enqueue([{ type: "update", path: "users/a", data: { v: 1 } }]).catch(() => {});
      expect(store.composeDocument("users/a")).toBeNull();
    });

    it("serverTimestamp を保留中マーカー（推定値 + 前回値）に解決する", () => {
      const { store } = setup();
      store.applyRemoteDoc(
        "users/a",
        true,
        { at: { __type: "timestamp", value: { seconds: 100, nanoseconds: 0 } } },
        "t",
        "t",
      );
      void store
        .enqueue([
          {
            type: "set",
            path: "users/a",
            data: { at: { __fieldValue: true, type: "serverTimestamp" } },
          },
        ])
        .catch(() => {});
      const composed = store.composeDocument("users/a");
      const at = composed?.data?.at as {
        __type: string;
        estimate: { value: { seconds: number } };
        previous: unknown;
      };
      expect(at.__type).toBe("pendingServerTimestamp");
      expect(Math.abs(at.estimate.value.seconds - Date.now() / 1000)).toBeLessThan(5);
      // 直前の確定値を保持している（'previous' 解決用）
      expect(at.previous).toEqual({ __type: "timestamp", value: { seconds: 100, nanoseconds: 0 } });
    });

    it("increment をキャッシュ値ベースで推定解決する", () => {
      const { store } = setup();
      store.applyRemoteDoc("users/a", true, { count: 10 }, "t1", "t1");
      void store
        .enqueue([
          {
            type: "set",
            path: "users/a",
            data: { count: { __fieldValue: true, type: "increment", value: 5 } },
            options: { merge: true },
          },
        ])
        .catch(() => {});
      expect(store.composeDocument("users/a")?.data).toEqual({ count: 15 });
    });
  });

  describe("mutation のライフサイクル", () => {
    it("観測中のパスは ack 後もサーバースナップショット観測まで overlay を保持する", async () => {
      const { store } = setup();
      store.addDocInterest("users/a");
      store.applyRemoteDoc("users/a", false, null, null, null);

      const write = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
      await write; // HTTP ack 済み

      // まだサーバースナップショットを観測していないため overlay は残る
      expect(store.pendingMutationCount).toBe(1);
      expect(store.composeDocument("users/a")?.hasPendingWrites).toBe(true);

      // ack の updateTime 以上のスナップショット観測で除去される
      store.applyRemoteDoc("users/a", true, { v: 1 }, "t", "2026-01-01T00:00:00.000001Z");
      expect(store.pendingMutationCount).toBe(0);
      expect(store.composeDocument("users/a")?.hasPendingWrites).toBe(false);
    });

    it("古いスナップショット（ack 前の値）では overlay を除去しない", async () => {
      const { store } = setup();
      store.addDocInterest("users/a");
      const write = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
      await write;

      // ack より古い updateTime のスナップショット
      store.applyRemoteDoc("users/a", true, { v: 0 }, "t", "2026-01-01T00:00:00.000000Z");
      expect(store.pendingMutationCount).toBe(1);
      // overlay が勝つためフリッカーしない
      expect(store.composeDocument("users/a")?.data).toEqual({ v: 1 });
    });

    it("観測者のいないパスは ack 時点で即除去される", async () => {
      const { store } = setup();
      await store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
      expect(store.pendingMutationCount).toBe(0);
    });

    it("delete は exists: false のスナップショット観測で除去される", async () => {
      const { store } = setup();
      store.addDocInterest("users/a");
      store.applyRemoteDoc("users/a", true, { v: 1 }, "t", "t");
      await store.enqueue([{ type: "delete", path: "users/a" }]);
      expect(store.pendingMutationCount).toBe(1);

      store.applyRemoteDoc("users/a", false, null, null, null);
      expect(store.pendingMutationCount).toBe(0);
    });

    it("HTTP 失敗時は mutation をロールバックして Promise を reject する", async () => {
      const { store, transport } = setup();
      transport.put.mockRejectedValue(new Error("boom"));
      store.applyRemoteDoc("users/a", true, { v: 0 }, "t", "t");

      const write = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
      await expect(write).rejects.toThrow("boom");

      expect(store.pendingMutationCount).toBe(0);
      // ロールバック後はリモート確定値に戻る
      expect(store.composeDocument("users/a")?.data).toEqual({ v: 0 });
    });

    it("途中の mutation が失敗しても後続は独立して送信される", async () => {
      const { store, transport } = setup();
      transport.put.mockRejectedValueOnce(new Error("boom"));

      const w1 = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
      const w2 = store.enqueue([{ type: "set", path: "users/b", data: { v: 2 } }]);

      await expect(w1).rejects.toThrow("boom");
      await expect(w2).resolves.toBeUndefined();
      expect(transport.put).toHaveBeenCalledTimes(2);
    });

    it("ローカル適用が不正なミューテーションは登録前に同期エラーになる", () => {
      const { store } = setup();
      expect(() =>
        store.enqueue([
          {
            type: "set",
            path: "users/a",
            data: { v: { __fieldValue: true, type: "deleteField" } },
          },
        ]),
      ).toThrow(/deleteField/);
      expect(store.pendingMutationCount).toBe(0);
    });
  });

  describe("バッチ mutation", () => {
    it("複数オペレーションを /batch でアトミックに送信する", async () => {
      const { store, transport } = setup();
      transport.post.mockResolvedValue({
        success: true,
        writeResults: [
          { path: "users/a", updateTime: "t1" },
          { path: "users/b", updateTime: "t1" },
        ],
      });

      const write = store.enqueue(
        [
          { type: "set", path: "users/a", data: { v: 1 } },
          { type: "set", path: "users/b", data: { v: 2 } },
        ],
        "batch",
      );

      // 両方のパスがローカルビューへ即時反映されている
      expect(store.composeDocument("users/a")?.data).toEqual({ v: 1 });
      expect(store.composeDocument("users/b")?.data).toEqual({ v: 2 });

      await write;
      expect(transport.post).toHaveBeenCalledWith("/batch", {
        operations: [
          { type: "set", path: "users/a", data: { v: 1 } },
          { type: "set", path: "users/b", data: { v: 2 } },
        ],
      });
    });
  });

  describe("一過性エラーの再送", () => {
    it("unavailable エラーでは mutation をキューに保持しバックオフ後に再送する", async () => {
      vi.useFakeTimers();
      try {
        const { store, transport } = setup();
        transport.put.mockRejectedValueOnce(new FirestoreError("unavailable", "server down"));
        store.applyRemoteDoc("users/a", true, { v: 0 }, "t", "t");

        const write = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
        let settled = false;
        void write.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        await vi.advanceTimersByTimeAsync(0); // 初回送信の失敗を処理
        // ロールバックされず、ローカルビューも書き込み後の値を維持する
        expect(store.pendingMutationCount).toBe(1);
        expect(store.composeDocument("users/a")?.data).toEqual({ v: 1 });
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1000); // バックオフ後の再送
        await expect(write).resolves.toBeUndefined();
        expect(transport.put).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("一過性エラー中は後続 mutation の送信も止めて順序を保つ", async () => {
      vi.useFakeTimers();
      try {
        const { store, transport } = setup();
        transport.put.mockRejectedValueOnce(new FirestoreError("unavailable", "server down"));

        const w1 = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
        const w2 = store.enqueue([{ type: "set", path: "users/b", data: { v: 2 } }]);

        await vi.advanceTimersByTimeAsync(0);
        expect(transport.put).toHaveBeenCalledTimes(1); // users/b はまだ送らない

        await vi.advanceTimersByTimeAsync(1000);
        await expect(w1).resolves.toBeUndefined();
        await expect(w2).resolves.toBeUndefined();
        expect(transport.put).toHaveBeenCalledTimes(3);
        // 再送は users/a → users/b の順
        expect(transport.put.mock.calls[1][0]).toBe("/docs/users/a");
        expect(transport.put.mock.calls[2][0]).toBe("/docs/users/b");
      } finally {
        vi.useRealTimers();
      }
    });

    it("連続失敗で再送間隔が指数的に伸びる", async () => {
      vi.useFakeTimers();
      try {
        const { store, transport } = setup();
        transport.put
          .mockRejectedValueOnce(new FirestoreError("unavailable", "down"))
          .mockRejectedValueOnce(new FirestoreError("deadline-exceeded", "slow"));

        const write = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);

        await vi.advanceTimersByTimeAsync(0); // 失敗 1 回目
        await vi.advanceTimersByTimeAsync(1000); // 1 秒後に再送 → 失敗 2 回目
        expect(transport.put).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1000); // まだ 2 秒経っていないので再送されない
        expect(transport.put).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(1000); // 2 秒後に再送 → 成功
        await expect(write).resolves.toBeUndefined();
        expect(transport.put).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clear() は再送タイマーを破棄する", async () => {
      vi.useFakeTimers();
      try {
        const { store, transport } = setup();
        transport.put.mockRejectedValueOnce(new FirestoreError("unavailable", "server down"));

        void store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
        await vi.advanceTimersByTimeAsync(0);
        expect(transport.put).toHaveBeenCalledTimes(1);

        store.clear();
        await vi.advanceTimersByTimeAsync(60000);
        expect(transport.put).toHaveBeenCalledTimes(1); // 再送されない
        expect(store.pendingMutationCount).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("恒久エラー（permission-denied 等）は従来どおりロールバックする", async () => {
      const { store, transport } = setup();
      transport.put.mockRejectedValue(new FirestoreError("permission-denied", "denied"));
      store.applyRemoteDoc("users/a", true, { v: 0 }, "t", "t");

      const write = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
      await expect(write).rejects.toThrow("denied");

      expect(store.pendingMutationCount).toBe(0);
      expect(store.composeDocument("users/a")?.data).toEqual({ v: 0 });
    });
  });

  describe("変更通知", () => {
    it("enqueue / applyRemoteDoc / ロールバックで変更パスが通知される", async () => {
      const { store, transport } = setup();
      const events: string[][] = [];
      store.onChange((paths) => events.push([...paths].sort()));

      store.applyRemoteDoc("users/a", true, { v: 0 }, "t", "t");
      expect(events.at(-1)).toEqual(["users/a"]);

      transport.put.mockRejectedValue(new Error("boom"));
      const write = store.enqueue([{ type: "set", path: "users/a", data: { v: 1 } }]);
      expect(events.at(-1)).toEqual(["users/a"]); // ローカル反映の通知

      await expect(write).rejects.toThrow();
      expect(events.length).toBeGreaterThanOrEqual(3); // ロールバックの通知
    });
  });
});
