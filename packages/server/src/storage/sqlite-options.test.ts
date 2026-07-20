import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, parseSynchronousMode } from "./sqlite.js";

describe("parseSynchronousMode", () => {
  it("有効な値を受け付ける（小文字も可）", () => {
    expect(parseSynchronousMode("FULL")).toBe("FULL");
    expect(parseSynchronousMode("normal")).toBe("NORMAL");
    expect(parseSynchronousMode("off")).toBe("OFF");
    expect(parseSynchronousMode("EXTRA")).toBe("EXTRA");
  });

  it("未指定・空文字は undefined を返す", () => {
    expect(parseSynchronousMode(undefined)).toBeUndefined();
    expect(parseSynchronousMode("")).toBeUndefined();
  });

  it("不正な値はエラーになる", () => {
    expect(() => parseSynchronousMode("SUPER")).toThrow(/Invalid DB_SYNCHRONOUS/);
  });
});

describe("createDatabase の synchronous オプション", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lf-sync-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("デフォルトは NORMAL（= 1）", () => {
    const db = createDatabase(join(tempDir, "a.db"));
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
  });

  it("FULL（= 2）を指定できる", () => {
    const db = createDatabase(join(tempDir, "b.db"), { synchronous: "FULL" });
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    db.close();
  });
});
