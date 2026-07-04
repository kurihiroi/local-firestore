import type {
  DocumentData,
  FieldValueSentinel,
  SerializedBytes,
  SerializedGeoPoint,
  SerializedReference,
  SerializedTimestamp,
  SerializedVectorValue,
} from "@local-firestore/shared";
import { isFieldValueSentinel } from "@local-firestore/shared";
import { Bytes } from "./bytes.js";
import { GeoPoint } from "./geo-point.js";
import { doc } from "./references.js";
import type { DocumentReference, Firestore } from "./types.js";
import { Timestamp } from "./types.js";
import { VectorValue } from "./vector.js";

/**
 * 書き込みデータのシリアライズ / 読み取りデータの復元
 *
 * 本家 Firestore SDK と同様に、Timestamp / GeoPoint / Bytes / VectorValue /
 * DocumentReference / Date をワイヤ形式（`{__type, ...}` ラッパー）へ変換し、
 * 読み取り時にクラスインスタンスへ復元する。
 */

interface SerializedWrapper {
  __type: "timestamp" | "geopoint" | "bytes" | "reference" | "vector";
}

function isSerializedWrapper(value: unknown): value is SerializedWrapper & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).__type === "string"
  );
}

function isDocumentReference(value: unknown): value is DocumentReference {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "document" &&
    typeof (value as Record<string, unknown>).path === "string" &&
    typeof (value as Record<string, unknown>).withConverter === "function"
  );
}

/** 単一の値をワイヤ形式へ変換する（ネスト構造も再帰的に処理） */
export function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (value instanceof Timestamp) {
    const serialized: SerializedTimestamp = {
      __type: "timestamp",
      value: { seconds: value.seconds, nanoseconds: value.nanoseconds },
    };
    return serialized;
  }
  if (value instanceof Date) {
    return serializeValue(Timestamp.fromDate(value));
  }
  if (value instanceof GeoPoint) {
    return value.toSerialized();
  }
  if (value instanceof Bytes) {
    return value.toSerialized();
  }
  if (value instanceof VectorValue) {
    return value.toSerialized();
  }
  if (isDocumentReference(value)) {
    const serialized: SerializedReference = { __type: "reference", value: value.path };
    return serialized;
  }
  if (isFieldValueSentinel(value)) {
    // arrayUnion / arrayRemove の要素にも特殊型が含まれうる
    const sentinel = value as FieldValueSentinel;
    if (Array.isArray(sentinel.value)) {
      return { ...sentinel, value: sentinel.value.map(serializeValue) };
    }
    return sentinel;
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue; // 本家同様、undefined フィールドは書き込まない
      result[k] = serializeValue(v);
    }
    return result;
  }
  return value;
}

/** ドキュメントデータ全体をワイヤ形式へ変換する */
export function serializeData(data: DocumentData): DocumentData {
  return serializeValue(data) as DocumentData;
}

/** ワイヤ形式の値をクラスインスタンスへ復元する */
export function deserializeValue(value: unknown, firestore: Firestore): unknown {
  if (value === null || value === undefined) return value;

  if (isSerializedWrapper(value)) {
    switch (value.__type) {
      case "timestamp": {
        const v = (value as unknown as SerializedTimestamp).value;
        return new Timestamp(v.seconds, v.nanoseconds);
      }
      case "geopoint":
        return GeoPoint.fromSerialized((value as unknown as SerializedGeoPoint).value);
      case "bytes":
        return Bytes.fromSerialized((value as unknown as SerializedBytes).value);
      case "reference":
        return doc(firestore, (value as unknown as SerializedReference).value);
      case "vector":
        return VectorValue.fromSerialized(value as unknown as SerializedVectorValue);
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => deserializeValue(v, firestore));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deserializeValue(v, firestore);
    }
    return result;
  }
  return value;
}

/** ワイヤ形式のドキュメントデータをクラスインスタンス付きへ復元する */
export function deserializeData(data: DocumentData, firestore: Firestore): DocumentData {
  return deserializeValue(data, firestore) as DocumentData;
}
