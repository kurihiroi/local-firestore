import type {
  AddDocumentRequest,
  AddDocumentResponse,
  DocumentData,
  GetDocumentResponse,
  PartialWithFieldValue,
  SetDocumentRequest,
  SetOptions,
  WithFieldValue,
} from "@local-firestore/shared";
import { doc } from "./references.js";
import { QueryDocumentSnapshot } from "./snapshots.js";
import type { CollectionReference, DocumentReference } from "./types.js";
import { DocumentSnapshot } from "./types.js";

/** ドキュメントを取得する */
export async function getDoc<T = DocumentData>(
  reference: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  const transport = reference._firestore._transport;
  const res = await transport.get<GetDocumentResponse>(`/docs/${reference.path}`);

  if (res.exists && reference._converter) {
    const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
      reference.path,
      reference.id,
      res.data as DocumentData,
      res.createTime ?? "",
      res.updateTime ?? "",
    );
    const converted = reference._converter.fromFirestore(rawSnapshot);
    return new DocumentSnapshot<T>(reference, converted as T, res.createTime, res.updateTime);
  }

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
  data: WithFieldValue<T>,
): Promise<void>;
export async function setDoc<T = DocumentData>(
  reference: DocumentReference<T>,
  data: PartialWithFieldValue<T>,
  options: SetOptions,
): Promise<void>;
export async function setDoc<T = DocumentData>(
  reference: DocumentReference<T>,
  data: WithFieldValue<T> | PartialWithFieldValue<T>,
  options?: SetOptions,
): Promise<void> {
  const transport = reference._firestore._transport;
  const dbData = reference._converter
    ? options
      ? reference._converter.toFirestore(data as PartialWithFieldValue<T>, options)
      : reference._converter.toFirestore(data as WithFieldValue<T>)
    : data;
  const body: SetDocumentRequest = { data: dbData as DocumentData, options };
  await transport.put(`/docs/${reference.path}`, body);
}

/** コレクションに新規ドキュメントを追加する（IDは自動生成） */
export async function addDoc<T = DocumentData>(
  reference: CollectionReference<T>,
  data: WithFieldValue<T>,
): Promise<DocumentReference<T>> {
  const transport = reference._firestore._transport;
  const dbData = reference._converter ? reference._converter.toFirestore(data) : data;
  const body: AddDocumentRequest = {
    collectionPath: reference.path,
    data: dbData as DocumentData,
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
