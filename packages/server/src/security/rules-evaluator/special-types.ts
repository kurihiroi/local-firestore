import type { RulesMap, RulesValue } from "./types.js";
import {
  mkBool,
  mkBytes,
  mkFloat,
  mkInt,
  mkLatLng,
  mkList,
  mkMap,
  mkNull,
  mkPath,
  mkString,
  mkTimestamp,
} from "./types.js";

/**
 * ドキュメントデータ（シリアライズ形式）をルール評価用の RulesValue に変換する。
 *
 * `{__type: "timestamp" | "geopoint" | "bytes" | "reference" | "vector"}` ラッパーを
 * 検出し、対応するルール型（timestamp / latlng / bytes / path / list）へ変換する。
 * これにより resource.data / request.resource.data 内の特殊型に対して
 * timestamp メソッドや比較演算子が本家と同じセマンティクスで動作する。
 */
export function documentValueToRulesValue(val: unknown): RulesValue {
  if (val === null || val === undefined) return mkNull();
  if (typeof val === "boolean") return mkBool(val);
  if (typeof val === "number") {
    return Number.isInteger(val) ? mkInt(val) : mkFloat(val);
  }
  if (typeof val === "string") return mkString(val);
  if (val instanceof Date) return mkTimestamp(val);
  if (val instanceof Uint8Array) return mkBytes(val);
  if (Array.isArray(val)) return mkList(val.map(documentValueToRulesValue));
  if (typeof val === "object") {
    const special = convertSpecialValue(val as Record<string, unknown>);
    if (special) return special;

    const map = new Map<string, RulesValue>();
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      map.set(k, documentValueToRulesValue(v));
    }
    return mkMap(map);
  }
  return mkNull();
}

/** ドキュメントデータ（トップレベル）を RulesMap に変換する */
export function documentDataToRulesMap(data: Record<string, unknown>): RulesMap {
  const map = new Map<string, RulesValue>();
  for (const [key, val] of Object.entries(data)) {
    map.set(key, documentValueToRulesValue(val));
  }
  return mkMap(map);
}

/** `__type` ラッパーを対応するルール型に変換する。ラッパーでなければ null */
function convertSpecialValue(obj: Record<string, unknown>): RulesValue | null {
  const type = obj.__type;
  if (typeof type !== "string") return null;

  switch (type) {
    case "timestamp": {
      const value = obj.value as { seconds?: unknown; nanoseconds?: unknown } | undefined;
      if (value && typeof value.seconds === "number" && typeof value.nanoseconds === "number") {
        const millis = value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
        return mkTimestamp(new Date(millis));
      }
      return null;
    }
    case "geopoint": {
      const value = obj.value as { latitude?: unknown; longitude?: unknown } | undefined;
      if (value && typeof value.latitude === "number" && typeof value.longitude === "number") {
        return mkLatLng(value.latitude, value.longitude);
      }
      return null;
    }
    case "bytes": {
      if (typeof obj.value === "string") {
        return mkBytes(new Uint8Array(Buffer.from(obj.value, "base64")));
      }
      return null;
    }
    case "reference": {
      if (typeof obj.value === "string") {
        return mkPath(`/databases/(default)/documents/${obj.value}`);
      }
      return null;
    }
    case "vector": {
      if (Array.isArray(obj.values)) {
        return mkList(
          obj.values.map((v) =>
            typeof v === "number" ? mkFloat(v) : documentValueToRulesValue(v),
          ),
        );
      }
      return null;
    }
    default:
      return null;
  }
}
