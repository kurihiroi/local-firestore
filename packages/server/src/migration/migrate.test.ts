import { describe, expect, it } from "vitest";
import { DocumentRepository } from "../storage/repository.js";
import { createDatabase } from "../storage/sqlite.js";
import { migrateDatabase } from "./migrate.js";

function setupDb() {
  const db = createDatabase(":memory:");
  const repo = new DocumentRepository(db);
  return { db, repo };
}

describe("migrateDatabase", () => {
  it("旧形式の Timestamp マップを変換し、レポートを返す", () => {
    const { db, repo } = setupDb();
    repo.set({
      path: "events/e1",
      collectionPath: "events",
      documentId: "e1",
      data: { createdAt: { seconds: 1700000000, nanoseconds: 123_456_789 }, name: "old" },
    });
    repo.set({
      path: "events/e2",
      collectionPath: "events",
      documentId: "e2",
      data: { name: "clean" },
    });

    const report = migrateDatabase(db);
    expect(report.scanned).toBe(2);
    expect(report.updated).toBe(1);
    expect(report.timestampsConverted).toBe(1);
    expect(report.nanosecondsTruncated).toBe(1);

    const migrated = repo.get("events/e1");
    expect(migrated?.data.createdAt).toEqual({
      __type: "timestamp",
      value: { seconds: 1700000000, nanoseconds: 123_456_000 },
    });
  });

  it("ラッパー形式のナノ秒精度 Timestamp を切り捨てる", () => {
    const { db, repo } = setupDb();
    repo.set({
      path: "events/e1",
      collectionPath: "events",
      documentId: "e1",
      data: { at: { __type: "timestamp", value: { seconds: 1, nanoseconds: 999 } } },
    });

    const report = migrateDatabase(db);
    expect(report.updated).toBe(1);
    expect(report.nanosecondsTruncated).toBe(1);
    expect(repo.get("events/e1")?.data.at).toEqual({
      __type: "timestamp",
      value: { seconds: 1, nanoseconds: 0 },
    });
  });

  it("旧 deleteField 文字列をレポートする（変換はしない）", () => {
    const { db, repo } = setupDb();
    repo.set({
      path: "docs/d1",
      collectionPath: "docs",
      documentId: "d1",
      data: { residue: "$$__DELETE__$$" },
    });

    const report = migrateDatabase(db);
    expect(report.legacyDeleteMarkers).toEqual([{ path: "docs/d1", field: "residue" }]);
    expect(report.updated).toBe(0);
    expect(repo.get("docs/d1")?.data.residue).toBe("$$__DELETE__$$");
  });

  it("dry-run では書き換えない", () => {
    const { db, repo } = setupDb();
    repo.set({
      path: "events/e1",
      collectionPath: "events",
      documentId: "e1",
      data: { createdAt: { seconds: 1, nanoseconds: 0 } },
    });

    const report = migrateDatabase(db, { dryRun: true });
    expect(report.updated).toBe(1);
    // 実データは変わっていない
    expect(repo.get("events/e1")?.data.createdAt).toEqual({ seconds: 1, nanoseconds: 0 });
  });

  it("version / updateTime は変更しない", () => {
    const { db, repo } = setupDb();
    repo.set({
      path: "events/e1",
      collectionPath: "events",
      documentId: "e1",
      data: { createdAt: { seconds: 1, nanoseconds: 0 } },
    });
    const before = repo.get("events/e1");

    migrateDatabase(db);
    const after = repo.get("events/e1");
    expect(after?.version).toBe(before?.version);
    expect(after?.updateTime).toBe(before?.updateTime);
  });
});
