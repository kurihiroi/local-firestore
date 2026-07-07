import type { DocumentData } from "@local-firestore/shared";

/**
 * ドキュメントデータの正規化（Timestamp のマイクロ秒切り捨て・旧形式変換）
 *
 * - 書き込みパス（DocumentService）: マイクロ秒切り捨てのみ
 * - migrate CLI / import 経路: 旧形式の変換 + 切り捨て + 旧 deleteField 文字列の検出
 */

/** 旧 deleteField センチネルの文字列表現（2026-07 以前） */
export const LEGACY_DELETE_MARKER = "$$__DELETE__$$";

/** 正規化の統計情報 */
export interface NormalizeStats {
  /** 素の {seconds, nanoseconds} マップから {__type: "timestamp"} へ変換した数 */
  timestampsConverted: number;
  /** ナノ秒をマイクロ秒精度へ切り捨てた数 */
  nanosecondsTruncated: number;
  /** 旧 deleteField 文字列（$$__DELETE__$$）が残存しているフィールドパス */
  legacyDeleteMarkerFields: string[];
}

export function emptyStats(): NormalizeStats {
  return { timestampsConverted: 0, nanosecondsTruncated: 0, legacyDeleteMarkerFields: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestampWrapper(
  value: unknown,
): value is { __type: "timestamp"; value: { seconds: number; nanoseconds: number } } {
  if (!isPlainObject(value) || value.__type !== "timestamp") return false;
  const v = value.value;
  return isPlainObject(v) && typeof v.seconds === "number" && typeof v.nanoseconds === "number";
}

/**
 * 素の {seconds, nanoseconds} マップ（旧形式のクライアント書き込み Timestamp）かどうか。
 * ちょうど2キーで両方が数値、nanoseconds が [0, 1e9) の場合のみ Timestamp とみなす
 * （ヒューリスティック。同じ形のユーザーマップも変換対象になる点は移行時の制約）。
 */
function isLegacyTimestampMap(value: unknown): value is { seconds: number; nanoseconds: number } {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("seconds" in value) || !("nanoseconds" in value)) return false;
  return (
    typeof value.seconds === "number" &&
    Number.isInteger(value.seconds) &&
    typeof value.nanoseconds === "number" &&
    Number.isInteger(value.nanoseconds) &&
    value.nanoseconds >= 0 &&
    value.nanoseconds < 1_000_000_000
  );
}

/** ナノ秒をマイクロ秒精度へ切り捨てる（本家仕様） */
export function truncateNanosToMicros(nanoseconds: number): number {
  return Math.floor(nanoseconds / 1000) * 1000;
}

interface NormalizeOptions {
  /** 素の {seconds, nanoseconds} マップを {__type: "timestamp"} へ変換する（migrate / import 用） */
  convertLegacyTimestamps?: boolean;
  /** 旧 deleteField 文字列を検出して stats に記録する（migrate 用。変換はしない） */
  detectLegacyDeleteMarkers?: boolean;
}

function normalizeValue(
  value: unknown,
  options: NormalizeOptions,
  stats: NormalizeStats,
  fieldPath: string,
): unknown {
  if (
    options.detectLegacyDeleteMarkers &&
    typeof value === "string" &&
    value === LEGACY_DELETE_MARKER
  ) {
    stats.legacyDeleteMarkerFields.push(fieldPath);
    return value;
  }

  if (isTimestampWrapper(value)) {
    const truncated = truncateNanosToMicros(value.value.nanoseconds);
    if (truncated !== value.value.nanoseconds) {
      stats.nanosecondsTruncated++;
      return {
        __type: "timestamp",
        value: { seconds: value.value.seconds, nanoseconds: truncated },
      };
    }
    return value;
  }

  if (options.convertLegacyTimestamps && isLegacyTimestampMap(value)) {
    stats.timestampsConverted++;
    const truncated = truncateNanosToMicros(value.nanoseconds);
    if (truncated !== value.nanoseconds) {
      stats.nanosecondsTruncated++;
    }
    return {
      __type: "timestamp",
      value: { seconds: value.seconds, nanoseconds: truncated },
    };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((v, i) => {
      const normalized = normalizeValue(v, options, stats, `${fieldPath}[${i}]`);
      if (normalized !== v) changed = true;
      return normalized;
    });
    return changed ? result : value;
  }

  if (isPlainObject(value)) {
    // 他の特殊型ラッパーの内部には踏み込まない
    if (typeof value.__type === "string") return value;
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const childPath = fieldPath ? `${fieldPath}.${k}` : k;
      const normalized = normalizeValue(v, options, stats, childPath);
      if (normalized !== v) changed = true;
      result[k] = normalized;
    }
    return changed ? result : value;
  }

  return value;
}

/**
 * 書き込みデータの Timestamp ナノ秒をマイクロ秒精度へ切り捨てる（書き込みパス用）。
 * 変更がない場合は同一の参照を返す。
 */
export function truncateTimestampsToMicros(data: DocumentData): DocumentData {
  const stats = emptyStats();
  return normalizeValue(data, {}, stats, "") as DocumentData;
}

/**
 * 旧形式データの正規化（migrate CLI / import 経路用）。
 *
 * - 素の {seconds, nanoseconds} マップ → {__type: "timestamp"}
 * - Timestamp のナノ秒をマイクロ秒精度へ切り捨て
 * - 旧 deleteField 文字列（$$__DELETE__$$）の検出（stats に記録、変換はしない）
 *
 * 変更がない場合、data は同一の参照を返す。
 */
export function normalizeLegacyDocumentData(data: DocumentData): {
  data: DocumentData;
  stats: NormalizeStats;
} {
  const stats = emptyStats();
  const normalized = normalizeValue(
    data,
    { convertLegacyTimestamps: true, detectLegacyDeleteMarkers: true },
    stats,
    "",
  ) as DocumentData;
  return { data: normalized, stats };
}
