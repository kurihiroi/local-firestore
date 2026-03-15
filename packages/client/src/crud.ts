import type {
  AddDocumentRequest,
  AddDocumentResponse,
  DocumentData,
  GetDocumentResponse,
  SetDocumentRequest,
} from "@local-firestore/shared";
import { doc } from "./references.js";
import type { CollectionReference, DocumentReference } from "./types.js";
import { DocumentSnapshot } from "./types.js";

/** ドキュメントを取得する */
export async function getDoc<T = DocumentData>(
  reference: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  const transport = reference._firestore._transport;
  const res = await transport.get<GetDocumentResponse>(`/docs/${reference.path}`);

  return new DocumentSnapshot<T>(
    reference,
    res.exists ? (res.data as T) : null,
    res.createTime,
    res.updateTime,
  );
}

/** ドキュメントを作成/上書きする */
export async function setDoc<T = DocumentData>(
  reference: DocumentReference<T>,
  data: T,
): Promise<void> {
  const transport = reference._firestore._transport;
  const body: SetDocumentRequest = { data: data as DocumentData };
  await transport.put(`/docs/${reference.path}`, body);
}

/** コレクションに新規ドキュメントを追加する（IDは自動生成） */
export async function addDoc<T = DocumentData>(
  reference: CollectionReference<T>,
  data: T,
): Promise<DocumentReference<T>> {
  const transport = reference._firestore._transport;
  const body: AddDocumentRequest = {
    collectionPath: reference.path,
    data: data as DocumentData,
  };
  const res = await transport.post<AddDocumentResponse>("/docs", body);
  return doc<T>(reference, res.documentId);
}

/** ドキュメントを部分更新する */
export async function updateDoc<T = DocumentData>(
  reference: DocumentReference<T>,
  data: Partial<T>,
): Promise<void> {
  const transport = reference._firestore._transport;
  await transport.patch(`/docs/${reference.path}`, { data });
}

/** ドキュメントを削除する */
export async function deleteDoc<T = DocumentData>(reference: DocumentReference<T>): Promise<void> {
  const transport = reference._firestore._transport;
  await transport.delete(`/docs/${reference.path}`);
}
