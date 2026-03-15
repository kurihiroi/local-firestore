export type {
  DocumentData,
  DocumentMetadata,
  FieldValueSentinel,
  FieldValueType,
  SerializedSpecialValue,
  SerializedTimestamp,
  SetOptions,
} from "./types.js";

export type {
  AddDocumentRequest,
  AddDocumentResponse,
  DeleteDocumentResponse,
  ErrorResponse,
  GetDocumentResponse,
  SetDocumentRequest,
  UpdateDocumentRequest,
} from "./protocol.js";

export { isFieldValueSentinel } from "./protocol.js";
