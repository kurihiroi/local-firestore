import { createHash } from "node:crypto";
import {
  type RulesValue,
  mkBytes,
} from "./types.js";

/**
 * hashing namespace 関数
 */
export function callHashingFunction(
  method: string,
  args: RulesValue[],
): RulesValue {
  if (args.length !== 1) {
    throw new Error(`hashing.${method}() expects 1 argument, got ${args.length}`);
  }

  const input = toBuffer(args[0]);

  switch (method) {
    case "md5":
      return mkBytes(hashWith("md5", input));

    case "sha256":
      return mkBytes(hashWith("sha256", input));

    case "crc32":
      return mkBytes(crc32Bytes(input, false));

    case "crc32c":
      return mkBytes(crc32Bytes(input, true));

    default:
      throw new Error(`Unknown hashing function: ${method}`);
  }
}

function toBuffer(val: RulesValue): Buffer {
  if (val.typeName === "string") {
    return Buffer.from(val.value, "utf-8");
  }
  if (val.typeName === "bytes") {
    return Buffer.from(val.value);
  }
  throw new Error(`hashing input must be string or bytes, got ${val.typeName}`);
}

function hashWith(algorithm: string, input: Buffer): Uint8Array {
  const hash = createHash(algorithm);
  hash.update(input);
  return new Uint8Array(hash.digest());
}

// ─── CRC32 実装 ───

function makeCRC32Table(castagnoli: boolean): Uint32Array {
  const polynomial = castagnoli ? 0x82f63b78 : 0xedb88320;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ polynomial;
      } else {
        crc = crc >>> 1;
      }
    }
    table[i] = crc >>> 0;
  }
  return table;
}

const CRC32_TABLE = makeCRC32Table(false);
const CRC32C_TABLE = makeCRC32Table(true);

function crc32Bytes(input: Buffer, castagnoli: boolean): Uint8Array {
  const table = castagnoli ? CRC32C_TABLE : CRC32_TABLE;
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ input[i]) & 0xff];
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  // 4バイトのビッグエンディアン
  const result = new Uint8Array(4);
  result[0] = (crc >>> 24) & 0xff;
  result[1] = (crc >>> 16) & 0xff;
  result[2] = (crc >>> 8) & 0xff;
  result[3] = crc & 0xff;
  return result;
}
