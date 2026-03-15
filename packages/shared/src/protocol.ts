import type { DocumentData, FieldValueSentinel, SerializedQueryConstraint, SetOptions } from "./types.js";

// ============================================================
// HTTP Request / Response
// ============================================================

/** GET /docs/:path レスポンス */
export interface GetDocumentResponse {
  exists: boolean;
  path: string;
  data: DocumentData | null;
  createTime: string | null;
  updateTime: string | null;
}

/** POST /docs リクエスト（addDoc） */
export interface AddDocumentRequest {
  collectionPath: string;
  data: DocumentData;
}

/** POST /docs レスポンス */
export interface AddDocumentResponse {
  path: string;
  documentId: string;
}

/** PUT /docs/:path リクエスト（setDoc） */
export interface SetDocumentRequest {
  data: DocumentData;
  options?: SetOptions;
}

/** PATCH /docs/:path リクエスト（updateDoc） */
export interface UpdateDocumentRequest {
  data: DocumentData;
}

/** DELETE /docs/:path レスポンス */
export interface DeleteDocumentResponse {
  success: boolean;
}

/** POST /query リクエスト */
export interface QueryRequest {
  collectionPath: string;
  collectionGroup?: boolean;
  constraints: SerializedQueryConstraint[];
}

/** POST /query レスポンス */
export interface QueryResponse {
  docs: QueryDocumentData[];
}

export interface QueryDocumentData {
  path: string;
  data: DocumentData;
  createTime: string;
  updateTime: string;
}

/** エラーレスポンス */
export interface ErrorResponse {
  code: string;
  message: string;
}

// ============================================================
// FieldValueの判定ヘルパー
// ============================================================

export function isFieldValueSentinel(value: unknown): value is FieldValueSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    "__fieldValue" in value &&
    (value as FieldValueSentinel).__fieldValue === true
  );
}
