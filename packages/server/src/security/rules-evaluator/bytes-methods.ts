import {
  type RulesValue,
  mkInt,
  mkString,
} from "./types.js";

/**
 * Bytes 型のメソッドをディスパッチする
 */
export function callBytesMethod(
  bytes: Uint8Array,
  method: string,
  args: RulesValue[],
): RulesValue {
  assertArgCount(method, args, 0);

  switch (method) {
    case "size":
      return mkInt(bytes.length);

    case "toBase64": {
      // Node.js 環境では Buffer を使用
      const base64 = Buffer.from(bytes).toString("base64");
      return mkString(base64);
    }

    case "toHexString": {
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return mkString(hex);
    }

    default:
      throw new Error(`Unknown bytes method: ${method}`);
  }
}

function assertArgCount(method: string, args: RulesValue[], expected: number): void {
  if (args.length !== expected) {
    throw new Error(`bytes.${method}() expects ${expected} argument(s), got ${args.length}`);
  }
}
