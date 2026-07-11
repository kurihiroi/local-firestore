import type {
  DocumentData,
  GetDocumentResponse,
  PartialWithFieldValue,
  SetOptions,
  UpdateData,
  WithFieldValue,
} from "@local-firestore/shared";
import { getLocalStore } from "./local-store.js";
import { doc } from "./references.js";
import { deserializeData, type SerializeOptions, serializeData } from "./serialization.js";
import { QueryDocumentSnapshot } from "./snapshots.js";
import { FirestoreError } from "./transport.js";
import type { CollectionReference, DocumentReference } from "./types.js";
import { DocumentSnapshot, FieldPath, SnapshotMetadata } from "./types.js";

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

  // サーバー確定値としてローカルストアへ反映する（キャッシュ読み取り・
  // acknowledged mutation の解決に使われる）
  getLocalStore(reference._firestore).applyRemoteDoc(
    reference.path,
    res.exists,
    res.data,
    res.createTime,
    res.updateTime,
  );

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

/**
 * ドキュメントをローカルキャッシュから取得する（本家互換）
 *
 * ローカルビュー（サーバー確定値 + pending write の overlay）を返す。
 * キャッシュ未命中（一度も観測しておらず pending write もない）の場合は
 * 本家同様 `unavailable` エラーを投げる。metadata は `fromCache: true`。
 */
export async function getDocFromCache<T = DocumentData>(
  reference: DocumentReference<T>,
): Promise<DocumentSnapshot<T>> {
  const composed = getLocalStore(reference._firestore).composeDocument(reference.path);
  if (!composed) {
    throw new FirestoreError(
      "unavailable",
      "Failed to get document from cache. (However, this document may exist on the server. " +
        "Run again without source set to 'cache' to attempt to retrieve the document from the server.)",
    );
  }

  const metadata = new SnapshotMetadata(composed.hasPendingWrites, true);
  let data: DocumentData | null = composed.exists
    ? deserializeData(composed.data as DocumentData, reference._firestore)
    : null;
  if (data && reference._converter) {
    const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
      reference.path,
      reference.id,
      data,
      composed.createTime ?? "",
      composed.updateTime ?? "",
      reference._firestore,
    );
    data = reference._converter.fromFirestore(rawSnapshot) as DocumentData;
  }
  return new DocumentSnapshot<T>(
    reference,
    data as T | null,
    composed.createTime,
    composed.updateTime,
    metadata,
  );
}

/** ドキュメントをサーバーから取得する（getDoc のエイリアス、本家互換） */
export const getDocFromServer = getDoc;

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
  const converted = reference._converter
    ? options
      ? reference._converter.toFirestore(data as PartialWithFieldValue<T>, options)
      : reference._converter.toFirestore(data as WithFieldValue<T>)
    : data;
  const dbData = serializeData(converted as DocumentData, serializeOptionsOf(reference._firestore));
  // ローカルビューへ即時反映（リスナーが hasPendingWrites: true で発火）し、
  // サーバー確定（ack）で resolve する
  return getLocalStore(reference._firestore).enqueue([
    { type: "set", path: reference.path, data: dbData as DocumentData, options },
  ]);
}

/** コレクションに新規ドキュメントを追加する（IDは自動生成） */
export async function addDoc<T = DocumentData>(
  reference: CollectionReference<T>,
  data: WithFieldValue<T>,
): Promise<DocumentReference<T>> {
  const converted = reference._converter ? reference._converter.toFirestore(data) : data;
  const dbData = serializeData(converted as DocumentData, serializeOptionsOf(reference._firestore));

  // 本家同様、ID はクライアント側で生成して set として書き込む
  // （レイテンシ補償でローカルビューに即時反映できるようにするため）
  const documentId = generateAutoId();
  const path = `${reference.path}/${documentId}`;
  await getLocalStore(reference._firestore).enqueue([
    { type: "set", path, data: dbData as DocumentData },
  ]);
  return doc<T>(reference, documentId);
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

  return getLocalStore(reference._firestore).enqueue([
    { type: "update", path: reference.path, data },
  ]);
}

/** ドキュメントを削除する */
export async function deleteDoc<T = DocumentData>(reference: DocumentReference<T>): Promise<void> {
  return getLocalStore(reference._firestore).enqueue([{ type: "delete", path: reference.path }]);
}
