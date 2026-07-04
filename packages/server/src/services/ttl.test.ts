import type { DocumentMetadata } from "@local-firestore/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentService } from "./document.js";
import { matchesCollectionPattern, TtlService } from "./ttl.js";

function timestampValue(ms: number) {
  return {
    __type: "timestamp",
    value: { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000 },
  };
}

describe("TtlService", () => {
  let repo: DocumentRepository;
  let documentService: DocumentService;
  let ttlService: TtlService;
  let deletedPaths: Array<{ path: string; oldDocument: DocumentMetadata }>;

  beforeEach(() => {
    const db = createDatabase(":memory:");
    repo = new DocumentRepository(db);
    documentService = new DocumentService(repo);
    deletedPaths = [];
    ttlService = new TtlService(
      documentService,
      (collectionPath) => repo.listCollection(collectionPath),
      (path, oldDocument) => {
        deletedPaths.push({ path, oldDocument });
      },
    );
  });

  afterEach(() => {
    ttlService.stop();
    vi.useRealTimers();
  });

  describe("ポリシー管理", () => {
    it("ポリシーを追加・削除できる", () => {
      ttlService.addPolicy({ collectionPath: "sessions", timestampField: "expireAt" });
      expect(ttlService.policyCount).toBe(1);
      expect(ttlService.removePolicy("sessions")).toBe(true);
      expect(ttlService.policyCount).toBe(0);
      expect(ttlService.removePolicy("sessions")).toBe(false);
    });
  });

  describe("cleanup()", () => {
    beforeEach(() => {
      ttlService.addPolicy({ collectionPath: "sessions", timestampField: "expireAt" });
    });

    it("SerializedTimestamp 形式の期限切れドキュメントを削除する", async () => {
      documentService.setDocument("sessions/expired", {
        expireAt: timestampValue(Date.now() - 1000),
      });
      documentService.setDocument("sessions/active", {
        expireAt: timestampValue(Date.now() + 60_000),
      });

      const result = await ttlService.cleanup();

      expect(result.deletedCount).toBe(1);
      expect(result.deletedPaths).toEqual(["sessions/expired"]);
      expect(documentService.getDocument("sessions/expired")).toBeUndefined();
      expect(documentService.getDocument("sessions/active")).toBeDefined();
    });

    it("ISO 文字列の期限切れドキュメントを削除する", async () => {
      documentService.setDocument("sessions/expired", {
        expireAt: new Date(Date.now() - 1000).toISOString(),
      });

      const result = await ttlService.cleanup();
      expect(result.deletedPaths).toEqual(["sessions/expired"]);
    });

    it("ミリ秒数値の期限切れドキュメントを削除する", async () => {
      documentService.setDocument("sessions/expired", { expireAt: Date.now() - 1000 });

      const result = await ttlService.cleanup();
      expect(result.deletedPaths).toEqual(["sessions/expired"]);
    });

    it("ネストしたフィールドパスの期限を解決する", async () => {
      ttlService.addPolicy({ collectionPath: "jobs", timestampField: "meta.expireAt" });
      documentService.setDocument("jobs/expired", {
        meta: { expireAt: Date.now() - 1000 },
      });

      const result = await ttlService.cleanup();
      expect(result.deletedPaths).toEqual(["jobs/expired"]);
    });

    it("TTL フィールドがないドキュメントは削除しない", async () => {
      documentService.setDocument("sessions/no-field", { name: "keep me" });

      const result = await ttlService.cleanup();
      expect(result.deletedCount).toBe(0);
      expect(documentService.getDocument("sessions/no-field")).toBeDefined();
    });

    it("削除時に onDocumentDeleted へ削除前ドキュメントを通知する", async () => {
      documentService.setDocument("sessions/expired", { expireAt: Date.now() - 1000 });

      await ttlService.cleanup();

      expect(deletedPaths).toHaveLength(1);
      expect(deletedPaths[0].path).toBe("sessions/expired");
      expect(deletedPaths[0].oldDocument.data).toHaveProperty("expireAt");
      expect(deletedPaths[0].oldDocument.path).toBe("sessions/expired");
    });
  });

  describe("start() / stop()", () => {
    it("インターバルごとに cleanup が実行される", async () => {
      vi.useFakeTimers();
      ttlService.addPolicy({ collectionPath: "sessions", timestampField: "expireAt" });
      documentService.setDocument("sessions/expired", { expireAt: Date.now() - 1000 });

      ttlService.start(1000);
      await vi.advanceTimersByTimeAsync(1000);

      expect(documentService.getDocument("sessions/expired")).toBeUndefined();
    });

    it("stop() 後は cleanup が実行されない", async () => {
      vi.useFakeTimers();
      ttlService.addPolicy({ collectionPath: "sessions", timestampField: "expireAt" });

      ttlService.start(1000);
      ttlService.stop();

      documentService.setDocument("sessions/expired", { expireAt: Date.now() - 1000 });
      await vi.advanceTimersByTimeAsync(5000);

      expect(documentService.getDocument("sessions/expired")).toBeDefined();
    });
  });
});

describe("matchesCollectionPattern()", () => {
  it("完全一致のパスにマッチする", () => {
    expect(matchesCollectionPattern("sessions", "sessions")).toBe(true);
    expect(matchesCollectionPattern("users", "sessions")).toBe(false);
  });

  it("ワイルドカードセグメントにマッチする", () => {
    expect(matchesCollectionPattern("users/alice/sessions", "users/{userId}/sessions")).toBe(true);
    expect(matchesCollectionPattern("users/bob/posts", "users/{userId}/sessions")).toBe(false);
  });

  it("セグメント数が異なる場合はマッチしない", () => {
    expect(matchesCollectionPattern("users/alice/sessions", "sessions")).toBe(false);
  });
});
