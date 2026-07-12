import { describe, expect, it } from "vitest";
import {
  calculateDocumentNameSize,
  calculateDocumentSize,
  calculateValueSize,
  DocumentValidationError,
  MAX_DOCUMENT_SIZE_BYTES,
  MAX_NESTING_DEPTH,
  validateDocumentWrite,
  validatePathSegments,
  validateWriteOperationCount,
} from "./limits.js";

describe("calculateDocumentNameSize", () => {
  it("should follow the official storage size formula", () => {
    // 本家ドキュメントの例: users/jeff → "users"(5+1) + "jeff"(4+1) + 16 = 27
    expect(calculateDocumentNameSize("users/jeff")).toBe(27);
  });
});

describe("calculateValueSize", () => {
  it("should size primitives per the official spec", () => {
    expect(calculateValueSize(null)).toBe(1);
    expect(calculateValueSize(true)).toBe(1);
    expect(calculateValueSize(42)).toBe(8);
    expect(calculateValueSize(3.14)).toBe(8);
    expect(calculateValueSize("abc")).toBe(4); // 3 + 1
  });

  it("should size special type wrappers", () => {
    expect(calculateValueSize({ __type: "timestamp", value: { seconds: 1, nanoseconds: 0 } })).toBe(
      8,
    );
    expect(calculateValueSize({ __type: "geopoint", value: { latitude: 1, longitude: 2 } })).toBe(
      16,
    );
    // "hello" (5 bytes) を base64 化したもの
    expect(
      calculateValueSize({ __type: "bytes", value: Buffer.from("hello").toString("base64") }),
    ).toBe(5);
    // reference: users/jeff のドキュメント名サイズ
    expect(calculateValueSize({ __type: "reference", value: "users/jeff" })).toBe(27);
    expect(calculateValueSize({ __type: "vector", values: [1, 2, 3] })).toBe(24);
  });

  it("should size arrays and maps recursively", () => {
    expect(calculateValueSize([1, 2])).toBe(16);
    // map: "a"(1+1) + 8 = 10
    expect(calculateValueSize({ a: 1 })).toBe(10);
  });

  it("should size multi-byte strings in UTF-8", () => {
    // "あ" = 3 bytes UTF-8 + 1
    expect(calculateValueSize("あ")).toBe(4);
  });
});

describe("calculateDocumentSize", () => {
  it("should follow the official example", () => {
    // 本家ドキュメントの例: users/jeff に { type: "Personal", done: false }
    // name 27 + "type"(4+1)+"Personal"(8+1) + "done"(4+1)+1 + 32 = 79
    expect(calculateDocumentSize("users/jeff", { type: "Personal", done: false })).toBe(79);
  });
});

describe("validateDocumentWrite", () => {
  it("should allow normal documents", () => {
    expect(() =>
      validateDocumentWrite("users/u1", { name: "Alice", nested: { a: [1, 2, { b: true }] } }),
    ).not.toThrow();
  });

  it("should reject documents over 1 MiB", () => {
    const big = "x".repeat(MAX_DOCUMENT_SIZE_BYTES);
    expect(() => validateDocumentWrite("users/u1", { data: big })).toThrow(DocumentValidationError);
  });

  it("should reject nesting depth over 20", () => {
    let value: unknown = 1;
    for (let i = 0; i < MAX_NESTING_DEPTH + 1; i++) {
      value = { nested: value };
    }
    expect(() => validateDocumentWrite("users/u1", { deep: value })).toThrow(
      DocumentValidationError,
    );
  });

  it("should allow nesting depth of exactly 20", () => {
    let value: unknown = 1;
    for (let i = 0; i < MAX_NESTING_DEPTH; i++) {
      value = { nested: value };
    }
    expect(() => validateDocumentWrite("users/u1", { deep: value })).not.toThrow();
  });

  it("should count arrays toward nesting depth", () => {
    let value: unknown = 1;
    for (let i = 0; i < MAX_NESTING_DEPTH + 1; i++) {
      value = [value];
    }
    expect(() => validateDocumentWrite("users/u1", { deep: value })).toThrow(
      DocumentValidationError,
    );
  });

  it("should reject reserved field names (__.*__)", () => {
    expect(() => validateDocumentWrite("users/u1", { __name__: 1 })).toThrow(
      DocumentValidationError,
    );
    expect(() => validateDocumentWrite("users/u1", { nested: { __id__: 1 } })).toThrow(
      DocumentValidationError,
    );
    // ドット記法パス内の予約セグメントも拒否
    expect(() => validateDocumentWrite("users/u1", { "a.__b__": 1 })).toThrow(
      DocumentValidationError,
    );
  });

  it("should allow special type wrappers (__type is not reserved)", () => {
    expect(() =>
      validateDocumentWrite("users/u1", {
        ts: { __type: "timestamp", value: { seconds: 1, nanoseconds: 0 } },
      }),
    ).not.toThrow();
  });

  it("should have error code invalid-argument", () => {
    try {
      validateDocumentWrite("users/u1", { __name__: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as DocumentValidationError).code).toBe("invalid-argument");
    }
  });
});

describe("validateWriteOperationCount", () => {
  it("should allow up to 500 operations", () => {
    expect(() => validateWriteOperationCount(500)).not.toThrow();
  });

  it("should reject more than 500 operations", () => {
    expect(() => validateWriteOperationCount(501)).toThrow(DocumentValidationError);
  });
});

describe("validatePathSegments", () => {
  it("正常なパスは通る", () => {
    expect(() => validatePathSegments("users/alice")).not.toThrow();
    expect(() => validatePathSegments("users/alice/posts/post1")).not.toThrow();
    expect(() => validatePathSegments("users/日本語ID")).not.toThrow();
  });

  it("空セグメントを拒否する", () => {
    expect(() => validatePathSegments("users//alice")).toThrow(DocumentValidationError);
    expect(() => validatePathSegments("users/alice/")).toThrow(DocumentValidationError);
    expect(() => validatePathSegments("/users/alice")).toThrow(DocumentValidationError);
  });

  it('単体の "." / ".." を拒否する', () => {
    expect(() => validatePathSegments("users/.")).toThrow(DocumentValidationError);
    expect(() => validatePathSegments("users/..")).toThrow(DocumentValidationError);
    // ドットを含むだけの ID は許可される
    expect(() => validatePathSegments("users/a.b")).not.toThrow();
    expect(() => validatePathSegments("users/...")).not.toThrow();
  });

  it("予約名（__.*__）を拒否する", () => {
    expect(() => validatePathSegments("users/__alice__")).toThrow(DocumentValidationError);
    expect(() => validatePathSegments("__users__/alice")).toThrow(DocumentValidationError);
    expect(() => validatePathSegments("users/____")).toThrow(DocumentValidationError);
    // 片側だけのアンダースコアは許可される
    expect(() => validatePathSegments("users/__alice")).not.toThrow();
    expect(() => validatePathSegments("users/alice__")).not.toThrow();
  });

  it("1500 バイト超の ID を拒否する（UTF-8 バイト数基準）", () => {
    expect(() => validatePathSegments(`users/${"a".repeat(1500)}`)).not.toThrow();
    expect(() => validatePathSegments(`users/${"a".repeat(1501)}`)).toThrow(
      DocumentValidationError,
    );
    // マルチバイト文字は文字数でなくバイト数で数える（あ = 3 バイト）
    expect(() => validatePathSegments(`users/${"あ".repeat(500)}`)).not.toThrow();
    expect(() => validatePathSegments(`users/${"あ".repeat(501)}`)).toThrow(
      DocumentValidationError,
    );
  });

  it("ドキュメント名 6 KiB 超のパスを拒否する", () => {
    // 1500 バイト以下のセグメントを重ねて全長 6144 バイト超にする
    const segment = "a".repeat(1400);
    const parts = ["c1", segment, "c2", segment, "c3", segment, "c4", segment, "c5", segment];
    expect(() => validatePathSegments(parts.join("/"))).toThrow(DocumentValidationError);

    // 6 KiB 以下の深いパスは通る
    expect(() => validatePathSegments(["c1", segment, "c2", segment].join("/"))).not.toThrow();
  });
});
