import type {
  DocumentData,
  FieldValueSentinel,
  SerializedBytes,
  SerializedDouble,
  SerializedGeoPoint,
  SerializedReference,
  SerializedTimestamp,
  SerializedVectorValue,
} from "@local-firestore/shared";
import { isFieldValueSentinel } from "@local-firestore/shared";
import { Bytes } from "./bytes.js";
import { GeoPoint } from "./geo-point.js";
import { doc } from "./references.js";
import { FirestoreError } from "./transport.js";
import type { DocumentReference, Firestore } from "./types.js";
import { isPendingServerTimestampWire, PendingServerTimestamp, Timestamp } from "./types.js";
import { VectorValue } from "./vector.js";

/**
 * 書き込みデータのシリアライズ / 読み取りデータの復元
 *
 * 本家 Firestore SDK と同様に、Timestamp / GeoPoint / Bytes / VectorValue /
 * DocumentReference / Date をワイヤ形式（`{__type, ...}` ラッパー）へ変換し、
 * 読み取り時にクラスインスタンスへ復元する。
 */

interface SerializedWrapper {
  __type: "timestamp" | "geopoint" | "bytes" | "reference" | "vector" | "double";
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

/** シリアライズ時のオプション */
export interface SerializeOptions {
  /**
   * true の場合、undefined 値のフィールドを黙って除外する
   * （本家 `FirestoreSettings.ignoreUndefinedProperties` 互換）。
   * デフォルトは false で、undefined 値は invalid-argument エラーになる（本家同様）。
   */
  ignoreUndefinedProperties?: boolean;
}

/** 単一の値をワイヤ形式へ変換する（ネスト構造も再帰的に処理） */
export function serializeValue(value: unknown, options?: SerializeOptions): unknown {
  return serializeValueInternal(value, options ?? {}, "", false);
}

function serializeValueInternal(
  value: unknown,
  options: SerializeOptions,
  fieldPath: string,
  insideArray: boolean,
): unknown {
  if (value === null || value === undefined) return value;

  // NaN / Infinity は JSON で表現できないためラッパーで運ぶ（本家は値として保存可能）
  if (typeof value === "number" && !Number.isFinite(value)) {
    const serialized: SerializedDouble = {
      __type: "double",
      value: Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity",
    };
    return serialized;
  }

  if (value instanceof Timestamp) {
    const serialized: SerializedTimestamp = {
      __type: "timestamp",
      value: { seconds: value.seconds, nanoseconds: value.nanoseconds },
    };
    return serialized;
  }
  if (value instanceof Date) {
    return serializeValueInternal(Timestamp.fromDate(value), options, fieldPath, insideArray);
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
    // FieldValue センチネルは配列内では使用できない（本家同様）
    if (insideArray) {
      throw new FirestoreError(
        "invalid-argument",
        `${(value as FieldValueSentinel).type}() is not currently supported inside arrays${fieldPathSuffix(fieldPath)}`,
      );
    }
    // arrayUnion / arrayRemove の要素にも特殊型が含まれうる
    const sentinel = value as FieldValueSentinel;
    if (Array.isArray(sentinel.value)) {
      return {
        ...sentinel,
        // arrayUnion / arrayRemove の要素は配列要素として扱う（センチネルのネスト禁止）
        value: sentinel.value.map((v, i) =>
          serializeValueInternal(v, options, `${fieldPath}[${i}]`, true),
        ),
      };
    }
    return sentinel;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => {
      if (v === undefined) {
        // 配列内の undefined は ignoreUndefinedProperties でも許容されない（本家同様）
        throw new FirestoreError(
          "invalid-argument",
          `Unsupported field value: undefined${fieldPathSuffix(`${fieldPath}[${i}]`)}`,
        );
      }
      return serializeValueInternal(v, options, `${fieldPath}[${i}]`, true);
    });
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = fieldPath ? `${fieldPath}.${k}` : k;
      if (v === undefined) {
        if (options.ignoreUndefinedProperties) continue;
        throw new FirestoreError(
          "invalid-argument",
          `Unsupported field value: undefined (found in field ${childPath}). ` +
            "Pass ignoreUndefinedProperties: true to getFirestore() settings to ignore undefined values.",
        );
      }
      result[k] = serializeValueInternal(v, options, childPath, false);
    }
    return result;
  }
  return value;
}

function fieldPathSuffix(fieldPath: string): string {
  return fieldPath ? ` (found in field ${fieldPath})` : "";
}

/** ドキュメントデータ全体をワイヤ形式へ変換する */
export function serializeData(data: DocumentData, options?: SerializeOptions): DocumentData {
  return serializeValue(data, options) as DocumentData;
}

/** ワイヤ形式の値をクラスインスタンスへ復元する */
export function deserializeValue(value: unknown, firestore: Firestore): unknown {
  if (value === null || value === undefined) return value;

  // 保留中 serverTimestamp マーカー（LocalStore のローカルビュー由来）
  if (isPendingServerTimestampWire(value)) {
    const est = value.estimate.value;
    return new PendingServerTimestamp(
      new Timestamp(est.seconds, est.nanoseconds),
      deserializeValue(value.previous, firestore),
    );
  }

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
      case "double":
        return Number((value as unknown as SerializedDouble).value);
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
