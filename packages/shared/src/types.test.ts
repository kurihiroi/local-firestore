import { describe, expect, it } from "vitest";
import type { FieldValueSentinel, UpdateData } from "./types.js";
import { ERROR_CODES } from "./types.js";

describe("ERROR_CODES", () => {
  it("全てのgRPCステータスコードが定義されている", () => {
    expect(ERROR_CODES.CANCELLED).toBe("cancelled");
    expect(ERROR_CODES.UNKNOWN).toBe("unknown");
    expect(ERROR_CODES.INVALID_ARGUMENT).toBe("invalid-argument");
    expect(ERROR_CODES.DEADLINE_EXCEEDED).toBe("deadline-exceeded");
    expect(ERROR_CODES.NOT_FOUND).toBe("not-found");
    expect(ERROR_CODES.ALREADY_EXISTS).toBe("already-exists");
    expect(ERROR_CODES.PERMISSION_DENIED).toBe("permission-denied");
    expect(ERROR_CODES.RESOURCE_EXHAUSTED).toBe("resource-exhausted");
    expect(ERROR_CODES.FAILED_PRECONDITION).toBe("failed-precondition");
    expect(ERROR_CODES.ABORTED).toBe("aborted");
    expect(ERROR_CODES.OUT_OF_RANGE).toBe("out-of-range");
    expect(ERROR_CODES.UNIMPLEMENTED).toBe("unimplemented");
    expect(ERROR_CODES.INTERNAL).toBe("internal");
    expect(ERROR_CODES.UNAVAILABLE).toBe("unavailable");
    expect(ERROR_CODES.DATA_LOSS).toBe("data-loss");
    expect(ERROR_CODES.UNAUTHENTICATED).toBe("unauthenticated");
  });

  it("16個のエラーコードが定義されている", () => {
    expect(Object.keys(ERROR_CODES)).toHaveLength(16);
  });

  it("各値がユニークである", () => {
    const values = Object.values(ERROR_CODES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });
});

describe("UpdateData (型テスト)", () => {
  type Profile = {
    name: string;
    age: number;
    address: {
      city: string;
      zip: string;
    };
  };

  it("トップレベルフィールドの部分更新を許可する", () => {
    const data: UpdateData<Profile> = { name: "Alice" };
    expect(data).toBeDefined();
  });

  it("ドット記法のネストフィールドキーを許可する", () => {
    const data: UpdateData<Profile> = { "address.city": "Tokyo" };
    const mixed: UpdateData<Profile> = { age: 30, "address.zip": "100-0001" };
    expect(data).toBeDefined();
    expect(mixed).toBeDefined();
  });

  it("ネストオブジェクトごとの置き換えも許可する", () => {
    const data: UpdateData<Profile> = { address: { city: "Osaka" } };
    expect(data).toBeDefined();
  });

  it("FieldValueセンチネルを値として許可する", () => {
    const sentinel: FieldValueSentinel = { __fieldValue: true, type: "deleteField" };
    const data: UpdateData<Profile> = { name: sentinel, "address.city": "Kyoto" };
    expect(data).toBeDefined();
  });

  it("存在しないフィールドや型不一致は型エラーになる", () => {
    // @ts-expect-error 存在しないフィールド
    const invalid1: UpdateData<Profile> = { unknown: 1 };
    // @ts-expect-error 存在しないネストフィールドのドット記法キー
    const invalid2: UpdateData<Profile> = { "address.country": "JP" };
    // @ts-expect-error ドット記法キーの値の型が一致しない
    const invalid3: UpdateData<Profile> = { "address.city": 123 };
    expect([invalid1, invalid2, invalid3]).toBeDefined();
  });
});
