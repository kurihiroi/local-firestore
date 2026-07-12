import type { DocumentData } from "./types.js";

/**
 * 本家 Firestore のプラットフォームリミット
 * https://firebase.google.com/docs/firestore/quotas
 */

/** ドキュメントの最大サイズ（1 MiB） */
export const MAX_DOCUMENT_SIZE_BYTES = 1_048_576;

/** バッチ / トランザクションあたりの最大書き込みオペレーション数 */
export const MAX_WRITE_OPERATIONS = 500;

/** マップ / 配列の最大ネスト深度 */
export const MAX_NESTING_DEPTH = 20;

/** ドキュメントサイズ計算に加算される固定オーバーヘッド（本家仕様） */
const DOCUMENT_SIZE_OVERHEAD = 32;

/** ドキュメント名サイズ計算に加算される固定オーバーヘッド（本家仕様） */
const DOCUMENT_NAME_OVERHEAD = 16;

/** 予約フィールド名パターン（`__.*__`） */
const RESERVED_FIELD_NAME_PATTERN = /^__.*__$/;

/**
 * ドキュメント書き込みのバリデーションエラー（本家準拠の invalid-argument）
 */
export class DocumentValidationError extends Error {
  readonly code = "invalid-argument";
  constructor(message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

const textEncoder = new TextEncoder();

/** UTF-8 バイト数を返す（ブラウザ互換のため Buffer は使わない） */
function utf8ByteLength(str: string): number {
  return textEncoder.encode(str).length;
}

/** Base64 文字列のデコード後バイト数を返す */
function base64DecodedLength(b64: string): number {
  const withoutPadding = b64.replace(/=+$/, "");
  return Math.floor((withoutPadding.length * 3) / 4);
}

/** `__type` ラッパー（シリアライズ済み特殊型）かどうか */
function isSpecialValueWrapper(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).__type === "string"
  );
}

/**
 * ドキュメント名（パス）のストレージサイズを計算する。
 * 本家仕様: 各セグメントの文字列サイズ（UTF-8 バイト数 + 1）の合計 + 16 バイト
 */
export function calculateDocumentNameSize(path: string): number {
  const segments = path.split("/");
  let size = DOCUMENT_NAME_OVERHEAD;
  for (const segment of segments) {
    size += utf8ByteLength(segment) + 1;
  }
  return size;
}

/**
 * フィールド値のストレージサイズを計算する（本家「ストレージサイズの計算」仕様）。
 *
 * - null / boolean: 1 バイト
 * - number（int / double）: 8 バイト
 * - string: UTF-8 バイト数 + 1
 * - timestamp: 8 バイト
 * - geopoint: 16 バイト
 * - bytes: デコード後のバイト数
 * - reference: ドキュメント名サイズ
 * - vector: 次元数 × 8 バイト
 * - array: 要素サイズの合計
 * - map: （キー文字列サイズ + 値サイズ）の合計
 */
export function calculateValueSize(value: unknown): number {
  if (value === null || value === undefined) return 1;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 8;
  if (typeof value === "string") return utf8ByteLength(value) + 1;
  if (Array.isArray(value)) {
    let size = 0;
    for (const el of value) {
      size += calculateValueSize(el);
    }
    return size;
  }
  if (isSpecialValueWrapper(value)) {
    switch (value.__type) {
      case "timestamp":
      case "double":
        return 8;
      case "geopoint":
        return 16;
      case "bytes": {
        const b64 = value.value;
        return typeof b64 === "string" ? base64DecodedLength(b64) : 1;
      }
      case "reference": {
        const refPath = value.value;
        return typeof refPath === "string" ? calculateDocumentNameSize(refPath) : 1;
      }
      case "vector": {
        const values = value.values;
        return Array.isArray(values) ? values.length * 8 : 1;
      }
      default:
        break; // 未知のラッパーは通常のマップとして計算
    }
  }
  if (typeof value === "object") {
    let size = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      size += utf8ByteLength(k) + 1 + calculateValueSize(v);
    }
    return size;
  }
  return 1;
}

/**
 * ドキュメント全体のストレージサイズを計算する。
 * 本家仕様: ドキュメント名サイズ + 各フィールド（名前 + 値）サイズの合計 + 32 バイト
 */
export function calculateDocumentSize(path: string, data: DocumentData): number {
  let size = calculateDocumentNameSize(path) + DOCUMENT_SIZE_OVERHEAD;
  for (const [key, value] of Object.entries(data)) {
    size += utf8ByteLength(key) + 1 + calculateValueSize(value);
  }
  return size;
}

/** マップ / 配列の最大ネスト深度を返す（トップレベルのフィールド値 = 深度1） */
function maxNestingDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let max = 0;
    for (const el of value) {
      const d = maxNestingDepth(el);
      if (d > max) max = d;
    }
    return max + 1;
  }
  // 特殊型ラッパーはスカラー扱い
  if (isSpecialValueWrapper(value)) return 0;
  if (typeof value === "object" && value !== null) {
    let max = 0;
    for (const v of Object.values(value as Record<string, unknown>)) {
      const d = maxNestingDepth(v);
      if (d > max) max = d;
    }
    return max + 1;
  }
  return 0;
}

/** 予約フィールド名（`__.*__`）を再帰的に検査し、違反したフィールド名を返す */
function findReservedFieldName(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const el of value) {
      const found = findReservedFieldName(el);
      if (found) return found;
    }
    return null;
  }
  if (isSpecialValueWrapper(value)) return null;
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // ドット記法パス（updateDoc）の場合はセグメントごとに検査する
      for (const segment of k.split(".")) {
        if (RESERVED_FIELD_NAME_PATTERN.test(segment)) {
          return segment;
        }
      }
      const found = findReservedFieldName(v);
      if (found) return found;
    }
    return null;
  }
  return null;
}

/**
 * ドキュメント書き込みデータを本家のプラットフォームリミットで検証する。
 *
 * - ドキュメントサイズ 1 MiB 超
 * - マップ / 配列のネスト深度 20 超
 * - 予約フィールド名（`__.*__`）
 *
 * 違反時は `DocumentValidationError`（code: invalid-argument）を投げる。
 */
export function validateDocumentWrite(path: string, data: DocumentData): void {
  const reserved = findReservedFieldName(data);
  if (reserved !== null) {
    throw new DocumentValidationError(
      `Field name "${reserved}" is reserved. Field names matching __.*__ are not allowed.`,
    );
  }

  // ネスト深度はフィールド値単位で数える（マップ / 配列 1 階層 = 深度1）
  for (const [key, value] of Object.entries(data)) {
    const depth = maxNestingDepth(value);
    if (depth > MAX_NESTING_DEPTH) {
      throw new DocumentValidationError(
        `Field "${key}" exceeds the maximum nesting depth of ${MAX_NESTING_DEPTH} (got ${depth})`,
      );
    }
  }

  const size = calculateDocumentSize(path, data);
  if (size > MAX_DOCUMENT_SIZE_BYTES) {
    throw new DocumentValidationError(
      `Document size (${size} bytes) exceeds the maximum of ${MAX_DOCUMENT_SIZE_BYTES} bytes`,
    );
  }
}

/**
 * バッチ / トランザクションのオペレーション数を検証する。
 * 500 超は `DocumentValidationError`（code: invalid-argument）を投げる。
 */
export function validateWriteOperationCount(count: number): void {
  if (count > MAX_WRITE_OPERATIONS) {
    throw new DocumentValidationError(
      `Too many write operations (${count}). Maximum is ${MAX_WRITE_OPERATIONS} per batch/transaction.`,
    );
  }
}

/** コレクション ID / ドキュメント ID の最大サイズ（1500 バイト、UTF-8） */
export const MAX_ID_BYTES = 1500;

/** ドキュメント名（パス）の最大サイズ（6 KiB、calculateDocumentNameSize 基準） */
export const MAX_DOCUMENT_NAME_BYTES = 6144;

/**
 * パスの各セグメント（コレクション ID / ドキュメント ID）とパス全長を
 * 本家仕様で検証する。
 *
 * - セグメントが空でない（`//` や末尾 `/` を含まない）
 * - セグメントが単体の `.` / `..` でない
 * - セグメントが予約名（`__.*__`）でない
 * - セグメントが 1500 バイト（UTF-8）以下
 * - ドキュメント名サイズが 6 KiB 以下
 *
 * 違反時は `DocumentValidationError`（code: invalid-argument）を投げる。
 * セグメント数の偶奇（ドキュメント / コレクション判定）は呼び出し側で検証する。
 */
export function validatePathSegments(path: string): void {
  for (const segment of path.split("/")) {
    if (segment.length === 0) {
      throw new DocumentValidationError(
        `Invalid path: "${path}". Paths must not contain empty segments.`,
      );
    }
    if (segment === "." || segment === "..") {
      throw new DocumentValidationError(
        `Invalid path segment: "${segment}". IDs cannot solely be "." or "..".`,
      );
    }
    if (RESERVED_FIELD_NAME_PATTERN.test(segment)) {
      throw new DocumentValidationError(
        `Invalid path segment: "${segment}". IDs matching __.*__ are reserved.`,
      );
    }
    if (utf8ByteLength(segment) > MAX_ID_BYTES) {
      throw new DocumentValidationError(
        `Invalid path segment: ID exceeds the maximum of ${MAX_ID_BYTES} bytes.`,
      );
    }
  }

  const nameSize = calculateDocumentNameSize(path);
  if (nameSize > MAX_DOCUMENT_NAME_BYTES) {
    throw new DocumentValidationError(
      `Document name (${nameSize} bytes) exceeds the maximum of ${MAX_DOCUMENT_NAME_BYTES} bytes.`,
    );
  }
}
