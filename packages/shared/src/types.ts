/** Firestoreドキュメントのデータ型 */
export interface DocumentData {
  [field: string]: unknown;
}

/** シリアライズされた特殊型のラッパー */
export interface SerializedSpecialValue {
  __type: "timestamp" | "geopoint" | "bytes" | "reference";
  value: unknown;
}

/** シリアライズされたTimestamp */
export interface SerializedTimestamp {
  __type: "timestamp";
  value: { seconds: number; nanoseconds: number };
}

/** FieldValueセンチネルの種別 */
export type FieldValueType = "serverTimestamp" | "deleteField" | "increment" | "arrayUnion" | "arrayRemove";

/** FieldValueセンチネル（クライアント→サーバーで送信される） */
export interface FieldValueSentinel {
  __fieldValue: true;
  type: FieldValueType;
  value?: unknown;
}

/** ドキュメントのメタデータ（サーバー内部で保持） */
export interface DocumentMetadata {
  path: string;
  collectionPath: string;
  documentId: string;
  data: DocumentData;
  version: number;
  createTime: string;
  updateTime: string;
}

/** SetOptions */
export type SetOptions = { merge: true } | { mergeFields: string[] };
