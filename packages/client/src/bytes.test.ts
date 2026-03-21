import { describe, expect, it } from "vitest";
import { Bytes } from "./bytes.js";

describe("Bytes", () => {
  it("Uint8Arrayから作成できる", () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const bytes = Bytes.fromUint8Array(data);
    const result = bytes.toUint8Array();
    expect(result).toEqual(data);
  });

  it("元のUint8Arrayを変更しても影響しない（コピー）", () => {
    const data = new Uint8Array([1, 2, 3]);
    const bytes = Bytes.fromUint8Array(data);
    data[0] = 99;
    expect(bytes.toUint8Array()[0]).toBe(1);
  });

  it("Base64文字列から作成できる", () => {
    const bytes = Bytes.fromBase64String("SGVsbG8="); // "Hello"
    const result = bytes.toUint8Array();
    expect(result).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });

  it("toBase64で正しくエンコードされる", () => {
    const bytes = Bytes.fromUint8Array(new Uint8Array([72, 101, 108, 108, 111]));
    expect(bytes.toBase64()).toBe("SGVsbG8=");
  });

  it("isEqualで比較できる", () => {
    const a = Bytes.fromUint8Array(new Uint8Array([1, 2, 3]));
    const b = Bytes.fromUint8Array(new Uint8Array([1, 2, 3]));
    const c = Bytes.fromUint8Array(new Uint8Array([1, 2, 4]));
    const d = Bytes.fromUint8Array(new Uint8Array([1, 2]));

    expect(a.isEqual(b)).toBe(true);
    expect(a.isEqual(c)).toBe(false);
    expect(a.isEqual(d)).toBe(false);
  });

  it("シリアライズ/デシリアライズが往復できる", () => {
    const original = Bytes.fromUint8Array(new Uint8Array([0, 1, 255, 128]));
    const serialized = original.toSerialized();

    expect(serialized.__type).toBe("bytes");
    expect(typeof serialized.value).toBe("string");

    const restored = Bytes.fromSerialized(serialized.value);
    expect(original.isEqual(restored)).toBe(true);
  });

  it("空のバイト列を扱える", () => {
    const bytes = Bytes.fromUint8Array(new Uint8Array([]));
    expect(bytes.toUint8Array()).toEqual(new Uint8Array([]));
    expect(bytes.toBase64()).toBe("");
  });
});
