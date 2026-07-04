/**
 * Firestore 互換のソートキーエンコーディング
 *
 * フィールド値を「文字列比較（memcmp）が Firestore の値順序と一致する」キーへ変換する。
 * これにより SQLite の WHERE / ORDER BY で本家 Firestore と同じ比較セマンティクスを実現する。
 *
 * Firestore の型順序（昇順）:
 *   null < boolean < number < Timestamp < string < Bytes
 *        < DocumentReference < GeoPoint < array < Vector < map
 *
 * 各キーは1文字の型タグで始まり、同型内の順序を保存する形で値をエンコードする。
 * 型タグは ASCII 順に並んでいるため、型をまたいだ比較も正しく行われる。
 */

/** 型タグ（ASCII 昇順 = Firestore の型順序） */
export const TYPE_TAG = {
  null: "1",
  boolean: "2",
  number: "3",
  timestamp: "4",
  string: "5",
  bytes: "6",
  reference: "7",
  geopoint: "8",
  array: "9",
  vector: "A",
  map: "B",
} as const;

/** 可変長コンテンツの終端文字。全ての型タグ・エスケープ済みバイトより小さい */
const TERMINATOR = "\u0001";

/**
 * 文字列を順序を保存したままエスケープする
 *
 * U+0000〜U+0002 を U+0002 プレフィックスの2文字列に写像し、終端文字 U+0001 と
 * 衝突しないようにする（プレフィックス関係にある文字列の順序も保存される）。
 */
function escapeString(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    result += code <= 2 ? `\u0002${String.fromCharCode(code + 1)}` : s[i];
  }
  return result;
}

/**
 * 数値を順序を保存する16文字の hex 文字列にエンコードする
 *
 * IEEE754 double のビットパターンに対して、正数は符号ビットを立て、
 * 負数は全ビット反転することで、バイト列比較 = 数値比較になる。
 */
export function encodeNumber(n: number): string {
  const buf = Buffer.alloc(8);
  // -0 と 0 は Firestore では等値
  buf.writeDoubleBE(n === 0 ? 0 : n, 0);
  if (buf[0] & 0x80) {
    for (let i = 0; i < 8; i++) buf[i] = ~buf[i] & 0xff;
  } else {
    buf[0] |= 0x80;
  }
  return buf.toString("hex");
}

interface SerializedWrapper {
  __type: string;
  [key: string]: unknown;
}

function isSerializedWrapper(value: unknown): value is SerializedWrapper {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).__type === "string"
  );
}

/**
 * パース済みの JSON 値から Firestore 順序キーを計算する
 */
export function valueKey(value: unknown): string {
  if (value === null || value === undefined) {
    return TYPE_TAG.null;
  }
  if (typeof value === "boolean") {
    return TYPE_TAG.boolean + (value ? "1" : "0");
  }
  if (typeof value === "number") {
    return TYPE_TAG.number + encodeNumber(value);
  }
  if (typeof value === "string") {
    return TYPE_TAG.string + escapeString(value) + TERMINATOR;
  }
  if (Array.isArray(value)) {
    return TYPE_TAG.array + value.map(valueKey).join("") + TERMINATOR;
  }
  if (isSerializedWrapper(value)) {
    switch (value.__type) {
      case "timestamp": {
        const v = value.value as { seconds: number; nanoseconds: number };
        return (
          TYPE_TAG.timestamp + encodeNumber(v.seconds) + String(v.nanoseconds).padStart(9, "0")
        );
      }
      case "bytes": {
        const binary = Buffer.from(String(value.value), "base64").toString("latin1");
        return TYPE_TAG.bytes + escapeString(binary) + TERMINATOR;
      }
      case "reference": {
        // パスセグメント単位の比較になるよう "/" を終端文字と同値に扱う
        const segments = String(value.value).split("/");
        return (
          TYPE_TAG.reference +
          segments.map((s) => escapeString(s) + TERMINATOR).join("") +
          TERMINATOR
        );
      }
      case "geopoint": {
        const v = value.value as { latitude: number; longitude: number };
        return TYPE_TAG.geopoint + encodeNumber(v.latitude) + encodeNumber(v.longitude);
      }
      case "vector": {
        const values = (value.values as number[]) ?? [];
        // Firestore はまず次元数、次に要素値で比較する
        return TYPE_TAG.vector + encodeNumber(values.length) + values.map(encodeNumber).join("");
      }
      default:
        // 未知の __type はマップとして扱う
        break;
    }
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    let result: string = TYPE_TAG.map;
    for (const k of keys) {
      result += escapeString(k) + TERMINATOR + valueKey(record[k]);
    }
    return result + TERMINATOR;
  }
  // boolean/number/string/object 以外の JSON 値は存在しない
  return TYPE_TAG.null;
}

/**
 * JSON テキスト（SQLite の `->` 演算子の出力）から順序キーを計算する
 *
 * @returns フィールドが存在しない（引数が null）場合は null
 */
export function computeFirestoreKey(json: string | null | undefined): string | null {
  if (json === null || json === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // `->` の出力は常に有効な JSON のはずだが、念のため文字列として扱う
    return valueKey(String(json));
  }
  return valueKey(parsed);
}

/** 値の型タグを返す（範囲フィルタの型ブラケット用） */
export function valueTypeTag(value: unknown): string {
  return valueKey(value).charAt(0);
}

/** 指定した型タグの次のタグ文字（排他的上限）を返す */
export function nextTypeTag(tag: string): string {
  return String.fromCharCode(tag.charCodeAt(0) + 1);
}

/** Firestore の等値セマンティクスでの配列 contains 判定 */
export function arrayContainsKey(
  arrayJson: string | null | undefined,
  elementKey: string,
): boolean {
  if (arrayJson === null || arrayJson === undefined) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some((el) => valueKey(el) === elementKey);
}
