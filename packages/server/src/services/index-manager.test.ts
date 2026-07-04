import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SerializedQueryConstraint } from "@local-firestore/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexManager } from "./index-manager.js";

describe("IndexManager", () => {
  it("単一フィールドクエリはバリデーション不要", () => {
    const manager = new IndexManager("error");
    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "name", op: "==", value: "Alice" },
    ];
    const result = manager.validateQuery("users", constraints);
    expect(result.valid).toBe(true);
  });

  it("複合クエリでインデックス未定義の場合エラーを返す", () => {
    const manager = new IndexManager("error");
    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "status", op: "==", value: "active" },
      { type: "orderBy", fieldPath: "createdAt", direction: "desc" },
    ];
    const result = manager.validateQuery("users", constraints);
    expect(result.valid).toBe(false);
    expect(result.missingIndex).toBeDefined();
    expect(result.message).toContain("Missing composite index");
  });

  it("インデックス定義済みならバリデーション成功", () => {
    const manager = new IndexManager("error");
    manager.loadConfiguration({
      indexes: [
        {
          collectionGroup: "users",
          queryScope: "COLLECTION",
          fields: [
            { fieldPath: "status", order: "ASCENDING" },
            { fieldPath: "createdAt", order: "DESCENDING" },
          ],
        },
      ],
    });

    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "status", op: "==", value: "active" },
      { type: "orderBy", fieldPath: "createdAt", direction: "desc" },
    ];
    const result = manager.validateQuery("users", constraints);
    expect(result.valid).toBe(true);
  });

  it("offモードでは常に成功", () => {
    const manager = new IndexManager("off");
    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "a", op: "==", value: 1 },
      { type: "where", fieldPath: "b", op: ">", value: 2 },
    ];
    const result = manager.validateQuery("test", constraints);
    expect(result.valid).toBe(true);
  });

  it("warnモードでは警告付きで成功", () => {
    const manager = new IndexManager("warn");
    const constraints: SerializedQueryConstraint[] = [
      { type: "where", fieldPath: "a", op: "==", value: 1 },
      { type: "orderBy", fieldPath: "b", direction: "asc" },
    ];
    const result = manager.validateQuery("test", constraints);
    expect(result.valid).toBe(true);
    expect(result.message).toContain("Missing composite index");
  });

  describe("loadConfigurationFromFile()", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "index-manager-test-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("firestore.indexes.json を読み込める", () => {
      const filePath = join(dir, "firestore.indexes.json");
      writeFileSync(
        filePath,
        JSON.stringify({
          indexes: [
            {
              collectionGroup: "users",
              queryScope: "COLLECTION",
              fields: [
                { fieldPath: "status", order: "ASCENDING" },
                { fieldPath: "createdAt", order: "DESCENDING" },
              ],
            },
          ],
          fieldOverrides: [],
        }),
      );

      const manager = new IndexManager("error");
      manager.loadConfigurationFromFile(filePath);

      expect(manager.size).toBe(1);
      const result = manager.validateQuery("users", [
        { type: "where", fieldPath: "status", op: "==", value: "active" },
        { type: "orderBy", fieldPath: "createdAt", direction: "desc" },
      ]);
      expect(result.valid).toBe(true);
    });

    it("不正な JSON でエラーを投げる", () => {
      const filePath = join(dir, "broken.json");
      writeFileSync(filePath, "{ not json");
      const manager = new IndexManager();
      expect(() => manager.loadConfigurationFromFile(filePath)).toThrow(
        "Failed to parse index configuration file",
      );
    });

    it("indexes 配列がない場合エラーを投げる", () => {
      const filePath = join(dir, "invalid.json");
      writeFileSync(filePath, JSON.stringify({ foo: "bar" }));
      const manager = new IndexManager();
      expect(() => manager.loadConfigurationFromFile(filePath)).toThrow(
        '"indexes" must be an array',
      );
    });

    it("存在しないファイルでエラーを投げる", () => {
      const manager = new IndexManager();
      expect(() => manager.loadConfigurationFromFile(join(dir, "missing.json"))).toThrow();
    });
  });

  it("sizeでインデックス数を取得できる", () => {
    const manager = new IndexManager();
    expect(manager.size).toBe(0);
    manager.loadConfiguration({
      indexes: [
        {
          collectionGroup: "users",
          queryScope: "COLLECTION",
          fields: [{ fieldPath: "a", order: "ASCENDING" }],
        },
      ],
    });
    expect(manager.size).toBe(1);
  });
});
