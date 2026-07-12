import { describe, expect, it } from "vitest";
import { formatFieldPath, parseFieldPath } from "./field-path.js";

describe("formatFieldPath", () => {
  it("単純セグメントはそのままドット結合する", () => {
    expect(formatFieldPath(["a"])).toBe("a");
    expect(formatFieldPath(["a", "b", "c"])).toBe("a.b.c");
    expect(formatFieldPath(["_private", "camelCase0"])).toBe("_private.camelCase0");
  });

  it("単純形式でないセグメントはバッククォートで囲む", () => {
    expect(formatFieldPath(["with-dash"])).toBe("`with-dash`");
    expect(formatFieldPath(["with space"])).toBe("`with space`");
    expect(formatFieldPath(["日本語"])).toBe("`日本語`");
    expect(formatFieldPath(["0start"])).toBe("`0start`");
    expect(formatFieldPath(["a.b"])).toBe("`a.b`");
    expect(formatFieldPath(["nested", "with-dash"])).toBe("nested.`with-dash`");
  });

  it("バッククォートとバックスラッシュをエスケープする", () => {
    expect(formatFieldPath(["a`b"])).toBe("`a\\`b`");
    expect(formatFieldPath(["a\\b"])).toBe("`a\\\\b`");
  });
});

describe("parseFieldPath", () => {
  it("従来のドット記法を分割する", () => {
    expect(parseFieldPath("a")).toEqual(["a"]);
    expect(parseFieldPath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("バッククォート内のドットは区切りとして扱わない", () => {
    expect(parseFieldPath("`a.b`")).toEqual(["a.b"]);
    expect(parseFieldPath("nested.`with-dash`")).toEqual(["nested", "with-dash"]);
    expect(parseFieldPath("`with space`.leaf")).toEqual(["with space", "leaf"]);
  });

  it("エスケープシーケンスを解決する", () => {
    expect(parseFieldPath("`a\\`b`")).toEqual(["a`b"]);
    expect(parseFieldPath("`a\\\\b`")).toEqual(["a\\b"]);
  });

  it("formatFieldPath とラウンドトリップする", () => {
    const cases = [
      ["simple"],
      ["a", "b"],
      ["with-dash"],
      ["a.b"],
      ["a`b", "c\\d"],
      ["日本語", "nested"],
    ];
    for (const segments of cases) {
      expect(parseFieldPath(formatFieldPath(segments))).toEqual(segments);
    }
  });
});
