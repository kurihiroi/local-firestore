import { describe, expect, it } from "vitest";
import { isFieldValueSentinel } from "./protocol.js";

describe("isFieldValueSentinel()", () => {
  it("正しいFieldValueSentinelをtrueと判定する", () => {
    expect(isFieldValueSentinel({ __fieldValue: true, type: "serverTimestamp" })).toBe(true);
    expect(isFieldValueSentinel({ __fieldValue: true, type: "deleteField" })).toBe(true);
    expect(isFieldValueSentinel({ __fieldValue: true, type: "increment", value: 5 })).toBe(true);
    expect(
      isFieldValueSentinel({ __fieldValue: true, type: "arrayUnion", value: ["a", "b"] }),
    ).toBe(true);
    expect(isFieldValueSentinel({ __fieldValue: true, type: "arrayRemove", value: [1, 2] })).toBe(
      true,
    );
  });

  it("__fieldValueがfalseの場合falseを返す", () => {
    expect(isFieldValueSentinel({ __fieldValue: false, type: "serverTimestamp" })).toBe(false);
  });

  it("__fieldValueがない場合falseを返す", () => {
    expect(isFieldValueSentinel({ type: "serverTimestamp" })).toBe(false);
  });

  it("nullの場合falseを返す", () => {
    expect(isFieldValueSentinel(null)).toBe(false);
  });

  it("undefinedの場合falseを返す", () => {
    expect(isFieldValueSentinel(undefined)).toBe(false);
  });

  it("文字列の場合falseを返す", () => {
    expect(isFieldValueSentinel("hello")).toBe(false);
  });

  it("数値の場合falseを返す", () => {
    expect(isFieldValueSentinel(42)).toBe(false);
  });

  it("配列の場合falseを返す", () => {
    expect(isFieldValueSentinel([1, 2, 3])).toBe(false);
  });

  it("空のオブジェクトの場合falseを返す", () => {
    expect(isFieldValueSentinel({})).toBe(false);
  });

  it("booleanの場合falseを返す", () => {
    expect(isFieldValueSentinel(true)).toBe(false);
    expect(isFieldValueSentinel(false)).toBe(false);
  });
});
