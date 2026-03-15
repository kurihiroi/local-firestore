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
// WebSocket メッセージ（リアルタイムリスナー）
// ============================================================

/** クライアント → サーバー: ドキュメントリスナー登録 */
export interface SubscribeDocMessage {
  type: "subscribe_doc";
  subscriptionId: string;
  path: string;
}

/** クライアント → サーバー: クエリリスナー登録 */
export interface SubscribeQueryMessage {
  type: "subscribe_query";
  subscriptionId: string;
  collectionPath: string;
  collectionGroup?: boolean;
  constraints: SerializedQueryConstraint[];
}

/** クライアント → サーバー: リスナー解除 */
export interface UnsubscribeMessage {
  type: "unsubscribe";
  subscriptionId: string;
}

/** クライアント → サーバー のメッセージ型 */
export type ClientMessage = SubscribeDocMessage | SubscribeQueryMessage | UnsubscribeMessage;

/** ドキュメント変更種別 */
export type DocumentChangeType = "added" | "modified" | "removed";

/** ドキュメント変更情報 */
export interface DocumentChangeData {
  type: DocumentChangeType;
  path: string;
  data: DocumentData | null;
  createTime: string | null;
  updateTime: string | null;
  oldIndex: number;
  newIndex: number;
}

/** サーバー → クライアント: ドキュメントスナップショット通知 */
export interface DocSnapshotMessage {
  type: "doc_snapshot";
  subscriptionId: string;
  exists: boolean;
  path: string;
  data: DocumentData | null;
  createTime: string | null;
  updateTime: string | null;
}

/** サーバー → クライアント: クエリスナップショット通知 */
export interface QuerySnapshotMessage {
  type: "query_snapshot";
  subscriptionId: string;
  docs: QueryDocumentData[];
  changes: DocumentChangeData[];
}

/** サーバー → クライアント: エラー通知 */
export interface SnapshotErrorMessage {
  type: "error";
  subscriptionId: string;
  code: string;
  message: string;
}

/** サーバー → クライアント のメッセージ型 */
export type ServerMessage = DocSnapshotMessage | QuerySnapshotMessage | SnapshotErrorMessage;

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
