import type {
  AddDocumentRequest,
  AddDocumentResponse,
  DocumentData,
  GetDocumentResponse,
  PartialWithFieldValue,
  SetDocumentRequest,
  SetOptions,
  UpdateData,
  WithFieldValue,
} from "@local-firestore/shared";
import { logDebug } from "./logger.js";
import { getWriteQueue, isNetworkEnabled } from "./network-state.js";
import { doc } from "./references.js";
import { deserializeData, type SerializeOptions, serializeData } from "./serialization.js";
import { QueryDocumentSnapshot } from "./snapshots.js";
import type { CollectionReference, DocumentReference } from "./types.js";
import { DocumentSnapshot, FieldPath } from "./types.js";

const AUTO_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Firestore互換の20文字のドキュメントIDをクライアント側で生成する */
function generateAutoId(): string {
  let id = "";
  for (let i = 0; i < 20; i++) {
    id += AUTO_ID_ALPHABET[Math.floor(Math.random() * AUTO_ID_ALPHABET.length)];
  }
  return id;
}

/** Firestore インスタンスの設定からシリアライズオプションを構築する */
function serializeOptionsOf(firestore: { _ignoreUndefinedProperties?: boolean }): SerializeOptions {
  return { ignoreUndefinedProperties: firestore._ignoreUndefinedProperties ?? false };
}

/** ドキュメントを取得する */
export async function getDoc<T = DocumentData>(
  reference: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  const transport = reference._firestore._transport;
  const res = await transport.get<GetDocumentResponse>(`/docs/${reference.path}`);

  const data = res.exists ? deserializeData(res.data as DocumentData, reference._firestore) : null;

  if (data && reference._converter) {
    const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
      reference.path,
      reference.id,
      data,
      res.createTime ?? "",
      res.updateTime ?? "",
      reference._firestore,
    );
    const converted = reference._converter.fromFirestore(rawSnapshot);
    return new DocumentSnapshot<T>(reference, converted as T, res.createTime, res.updateTime);
  }

  return new DocumentSnapshot<T>(reference, data as T | null, res.createTime, res.updateTime);
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
  const converted = reference._converter
    ? options
      ? reference._converter.toFirestore(data as PartialWithFieldValue<T>, options)
      : reference._converter.toFirestore(data as WithFieldValue<T>)
    : data;
  const dbData = serializeData(converted as DocumentData, serializeOptionsOf(reference._firestore));
  if (!isNetworkEnabled(reference._firestore)) {
    logDebug(`Network disabled, queueing set for ${reference.path}`);
    getWriteQueue(reference._firestore).enqueue(
      "set",
      reference.path,
      dbData as DocumentData,
      options,
    );
    return;
  }
  const body: SetDocumentRequest = { data: dbData as DocumentData, options };
  await transport.put(`/docs/${reference.path}`, body);
}

/** コレクションに新規ドキュメントを追加する（IDは自動生成） */
export async function addDoc<T = DocumentData>(
  reference: CollectionReference<T>,
  data: WithFieldValue<T>,
): Promise<DocumentReference<T>> {
  const transport = reference._firestore._transport;
  const converted = reference._converter ? reference._converter.toFirestore(data) : data;
  const dbData = serializeData(converted as DocumentData, serializeOptionsOf(reference._firestore));
  if (!isNetworkEnabled(reference._firestore)) {
    // オフライン時は ID をクライアント側で生成し、set としてキューする
    const documentId = generateAutoId();
    const path = `${reference.path}/${documentId}`;
    logDebug(`Network disabled, queueing add as set for ${path}`);
    getWriteQueue(reference._firestore).enqueue("set", path, dbData as DocumentData);
    return doc<T>(reference, documentId);
  }
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
  data: UpdateData<T>,
): Promise<void>;
export async function updateDoc<T = DocumentData>(
  reference: DocumentReference<T>,
  field: string | FieldPath,
  value: unknown,
  ...moreFieldsAndValues: unknown[]
): Promise<void>;
export async function updateDoc<T = DocumentData>(
  reference: DocumentReference<T>,
  dataOrField: UpdateData<T> | string | FieldPath,
  ...moreFieldsAndValues: unknown[]
): Promise<void> {
  const transport = reference._firestore._transport;
  let raw: Record<string, unknown>;

  if (typeof dataOrField === "string" || dataOrField instanceof FieldPath) {
    // フィールドパス形式: updateDoc(ref, field, value, field2, value2, ...)
    const fieldPath = typeof dataOrField === "string" ? dataOrField : dataOrField.toString();
    if (moreFieldsAndValues.length === 0) {
      throw new Error("updateDoc with field path requires a value argument");
    }
    // ドット記法キーはそのまま送信し、サーバー側でリーフのみ更新する
    // （ネスト展開すると親マップ全体の置換になり本家と挙動が変わるため）
    const obj: Record<string, unknown> = {};
    obj[fieldPath] = moreFieldsAndValues[0];

    // 残りのペアを処理
    for (let i = 1; i < moreFieldsAndValues.length; i += 2) {
      const key = moreFieldsAndValues[i];
      const val = moreFieldsAndValues[i + 1];
      const keyStr = key instanceof FieldPath ? key.toString() : String(key);
      obj[keyStr] = val;
    }
    raw = obj;
  } else {
    raw = dataOrField as Record<string, unknown>;
  }

  const data = serializeData(raw as DocumentData, serializeOptionsOf(reference._firestore));

  if (!isNetworkEnabled(reference._firestore)) {
    logDebug(`Network disabled, queueing update for ${reference.path}`);
    getWriteQueue(reference._firestore).enqueue("update", reference.path, data);
    return;
  }
  await transport.patch(`/docs/${reference.path}`, { data });
}

/** ドキュメントを削除する */
export async function deleteDoc<T = DocumentData>(reference: DocumentReference<T>): Promise<void> {
  if (!isNetworkEnabled(reference._firestore)) {
    logDebug(`Network disabled, queueing delete for ${reference.path}`);
    getWriteQueue(reference._firestore).enqueue("delete", reference.path);
    return;
  }
  const transport = reference._firestore._transport;
  await transport.delete(`/docs/${reference.path}`);
}
