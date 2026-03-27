import { describe, expect, it } from "vitest";
import {
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
} from "./field-values.js";

describe("serverTimestamp()", () => {
  it("serverTimestamp型のセンチネルを返す", () => {
    const sentinel = serverTimestamp();
    expect(sentinel).toEqual({ __fieldValue: true, type: "serverTimestamp" });
  });

  it("毎回新しいオブジェクトを返す", () => {
    const a = serverTimestamp();
    const b = serverTimestamp();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("deleteField()", () => {
  it("deleteField型のセンチネルを返す", () => {
    const sentinel = deleteField();
    expect(sentinel).toEqual({ __fieldValue: true, type: "deleteField" });
  });
});

describe("increment()", () => {
  it("正の数でincrement型のセンチネルを返す", () => {
    const sentinel = increment(5);
    expect(sentinel).toEqual({ __fieldValue: true, type: "increment", value: 5 });
  });

  it("負の数でincrement型のセンチネルを返す", () => {
    const sentinel = increment(-3);
    expect(sentinel).toEqual({ __fieldValue: true, type: "increment", value: -3 });
  });

  it("0でincrement型のセンチネルを返す", () => {
    const sentinel = increment(0);
    expect(sentinel).toEqual({ __fieldValue: true, type: "increment", value: 0 });
  });

  it("小数でincrement型のセンチネルを返す", () => {
    const sentinel = increment(1.5);
    expect(sentinel).toEqual({ __fieldValue: true, type: "increment", value: 1.5 });
  });
});

describe("arrayUnion()", () => {
  it("要素をvalue配列に含むセンチネルを返す", () => {
    const sentinel = arrayUnion("a", "b", "c");
    expect(sentinel).toEqual({ __fieldValue: true, type: "arrayUnion", value: ["a", "b", "c"] });
  });

  it("空の引数で空配列のセンチネルを返す", () => {
    const sentinel = arrayUnion();
    expect(sentinel).toEqual({ __fieldValue: true, type: "arrayUnion", value: [] });
  });

  it("単一要素で配列のセンチネルを返す", () => {
    const sentinel = arrayUnion(42);
    expect(sentinel).toEqual({ __fieldValue: true, type: "arrayUnion", value: [42] });
  });

  it("オブジェクト要素を含められる", () => {
    const sentinel = arrayUnion({ name: "Alice" }, { name: "Bob" });
    expect(sentinel).toEqual({
      __fieldValue: true,
      type: "arrayUnion",
      value: [{ name: "Alice" }, { name: "Bob" }],
    });
  });
});

describe("arrayRemove()", () => {
  it("要素をvalue配列に含むセンチネルを返す", () => {
    const sentinel = arrayRemove("x", "y");
    expect(sentinel).toEqual({ __fieldValue: true, type: "arrayRemove", value: ["x", "y"] });
  });

  it("空の引数で空配列のセンチネルを返す", () => {
    const sentinel = arrayRemove();
    expect(sentinel).toEqual({ __fieldValue: true, type: "arrayRemove", value: [] });
  });
});
