import type {
  DocumentData,
  FieldValueSentinel,
  SerializedQueryConstraint,
  SetOptions,
} from "./types.js";

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

// ============================================================
// Batch
// ============================================================

/** バッチ操作の種別 */
export type BatchOperationType = "set" | "update" | "delete";

export interface BatchOperation {
  type: BatchOperationType;
  path: string;
  data?: DocumentData;
}

/** POST /batch リクエスト */
export interface BatchRequest {
  operations: BatchOperation[];
}

/** POST /batch レスポンス */
export interface BatchResponse {
  success: boolean;
}

// ============================================================
// Transaction
// ============================================================

/** POST /transaction/begin レスポンス */
export interface TransactionBeginResponse {
  transactionId: string;
}

/** POST /transaction/get リクエスト */
export interface TransactionGetRequest {
  transactionId: string;
  path: string;
}

/** POST /transaction/commit リクエスト */
export interface TransactionCommitRequest {
  transactionId: string;
  operations: BatchOperation[];
}

/** POST /transaction/commit レスポンス */
export interface TransactionCommitResponse {
  success: boolean;
}

/** POST /transaction/rollback リクエスト */
export interface TransactionRollbackRequest {
  transactionId: string;
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
