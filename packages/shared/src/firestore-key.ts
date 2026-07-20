/**
 * Firestore 互換のソートキーエンコーディング
 *
 * フィールド値を「文字列比較（memcmp）が Firestore の値順序と一致する」キーへ変換する。
 * サーバーは SQLite の WHERE / ORDER BY（`firestore_key` UDF）で、クライアントは
 * ローカルクエリ評価（query-matcher）で同一の比較セマンティクスを共有する。
 *
 * Firestore の型順序（昇順）:
 *   null < boolean < number < Timestamp < string < Bytes
 *        < DocumentReference < GeoPoint < array < Vector < map
 *
 * 各キーは1文字の型タグで始まり、同型内の順序を保存する形で値をエンコードする。
 * 型タグは ASCII 順に並んでいるため、型をまたいだ比較も正しく行われる。
 *
 * ブラウザ互換のため Node.js の Buffer は使わない（DataView / atob ベース）。
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
 * 文字列を UTF-8 バイト順（= Unicode コードポイント順）を保存する形でエスケープする
 *
 * 本家 Firestore の文字列順序は UTF-8 バイト順。JS の生文字列比較は UTF-16
 * コード単位順のため、サロゲートペア（U+10000 以上）が U+E000〜U+FFFF より
 * 手前に来てしまう。そこで各コードポイントを UTF-8 バイト列へ展開し、
 * 1 バイトを 1 文字（U+0000〜U+00FF）として並べる。この表現は
 * - JS の文字列比較（クライアントの query-matcher）ではバイト順 = UTF-8 順
 * - SQLite TEXT の memcmp（サーバーの firestore_key UDF）でも同順
 *   （latin1 範囲の文字は UTF-8 で C2/C3 + 継続バイトになるが順序は保存される）
 * になり、両者の比較が本家の順序と一致する。
 *
 * バイト値 0x00〜0x02 は U+0002 プレフィックスの2文字列に写像し、終端文字
 * U+0001 と衝突しないようにする（プレフィックス関係にある文字列の順序も
 * 保存される）。UTF-8 の継続バイト・リードバイトは 0x80 以上のため
 * このエスケープと衝突することはない。
 */
function escapeString(s: string): string {
  let result = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    // ASCII（0x03〜0x7F）は UTF-8 でも1バイトそのまま
    if (code >= 3 && code < 0x80) {
      result += s[i];
      continue;
    }
    if (code <= 2) {
      result += `\u0002${String.fromCharCode(code + 1)}`;
      continue;
    }
    // コードポイントを取得（サロゲートペアを合成。孤立サロゲートはそのまま扱う）
    let cp = code;
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    // UTF-8 バイト列へ展開（1バイト = 1文字）
    if (cp < 0x800) {
      result += String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      result += String.fromCharCode(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      result += String.fromCharCode(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return result;
}

/** Base64 文字列を latin1（バイト値そのままの文字列）へデコードする */
function base64ToLatin1(b64: string): string {
  // atob はブラウザ / Node.js 16+ の両方でグローバルに利用可能
  return atob(b64);
}

/**
 * 数値を順序を保存する16文字の hex 文字列にエンコードする
 *
 * IEEE754 double のビットパターンに対して、正数は符号ビットを立て、
 * 負数は全ビット反転することで、バイト列比較 = 数値比較になる。
 * NaN は本家 Firestore と同様に数値の最小値（-Infinity より小さい）として扱う。
 */
export function encodeNumber(n: number): string {
  // NaN < -Infinity（-Infinity のエンコードは 000fff... なので全ゼロはそれより小さい）
  if (Number.isNaN(n)) {
    return "0".repeat(16);
  }
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // -0 と 0 は Firestore では等値
  view.setFloat64(0, n === 0 ? 0 : n, false /* big-endian */);
  const bytes = new Uint8Array(buf);
  if (bytes[0] & 0x80) {
    for (let i = 0; i < 8; i++) bytes[i] = ~bytes[i] & 0xff;
  } else {
    bytes[0] |= 0x80;
  }
  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * ドキュメントパスをセグメント単位の順序を保存するキーへ変換する
 *
 * 本家 Firestore の `__name__` 順序は完全リソース名のセグメント単位の比較。
 * 生のパス文字列比較では "/"（U+002F）より小さい文字（"-" 等）を ID に含むとき
 * 順序が壊れるため（例: "user-1/posts/x" < "user/posts/y" になってしまう）、
 * 各セグメントを終端文字付きでエスケープして memcmp = セグメント順にする。
 */
export function pathOrderKey(path: string): string {
  return path
    .split("/")
    .map((s) => escapeString(s) + TERMINATOR)
    .join("");
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
      case "double": {
        // NaN / Infinity / -Infinity のワイヤ表現（JSON では表現できないため）
        return TYPE_TAG.number + encodeNumber(Number(value.value));
      }
      case "timestamp": {
        const v = value.value as { seconds: number; nanoseconds: number };
        return (
          TYPE_TAG.timestamp + encodeNumber(v.seconds) + String(v.nanoseconds).padStart(9, "0")
        );
      }
      case "bytes": {
        const binary = base64ToLatin1(String(value.value));
        return TYPE_TAG.bytes + escapeString(binary) + TERMINATOR;
      }
      case "reference": {
        // パスセグメント単位の比較になるよう "/" を終端文字と同値に扱う
        return TYPE_TAG.reference + pathOrderKey(String(value.value)) + TERMINATOR;
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
    // 本家はマップキーも UTF-8 バイト順で比較する（Object.keys().sort() の
    // UTF-16 順ではサロゲートペアのキーの位置がズレる）
    const keys = Object.keys(record)
      .map((k) => ({ k, escaped: escapeString(k) }))
      .sort((a, b) => (a.escaped < b.escaped ? -1 : a.escaped > b.escaped ? 1 : 0));
    let result: string = TYPE_TAG.map;
    for (const { escaped, k } of keys) {
      result += escaped + TERMINATOR + valueKey(record[k]);
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
