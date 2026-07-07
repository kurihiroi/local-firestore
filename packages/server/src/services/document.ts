import type {
  DocumentData,
  DocumentMetadata,
  FirestoreErrorCode,
  SetOptions,
} from "@local-firestore/shared";
import {
  DocumentValidationError,
  isFieldValueSentinel,
  validateDocumentWrite,
} from "@local-firestore/shared";
import { truncateTimestampsToMicros } from "../migration/normalize.js";
import type { DocumentRepository } from "../storage/repository.js";
import { generateDocumentId } from "../utils/id.js";
import { parseDocumentPath } from "../utils/path.js";

/**
 * deleteField センチネルのサーバー内部表現（プロトコルレベル）
 *
 * 以前は文字列 "$$__DELETE__$$" を使用していたが、同じ文字列値の書き込みと
 * 衝突するため（意図しないフィールド削除 = データ破損リスク）、他の特殊型と
 * 統一した `{__type: "delete"}` 形式に変更した。
 */
interface DeleteMarker {
  __type: "delete";
}

const DELETE_MARKER: DeleteMarker = { __type: "delete" };

/** 値が deleteField マーカーかどうか */
function isDeleteMarker(value: unknown): value is DeleteMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).__type === "delete"
  );
}

/** deleteField マーカーが値の中に含まれるか（ネスト構造も検査） */
function containsDeleteMarker(value: unknown): boolean {
  if (isDeleteMarker(value)) return true;
  if (Array.isArray(value)) return value.some(containsDeleteMarker);
  if (isPlainObject(value) && !isSpecialValueWrapper(value)) {
    return Object.values(value).some(containsDeleteMarker);
  }
  return false;
}

export class DocumentService {
  constructor(private repo: DocumentRepository) {}

  getDocument(path: string): DocumentMetadata | undefined {
    return this.repo.get(path);
  }

  setDocument(path: string, data: DocumentData, options?: SetOptions): DocumentMetadata {
    const { collectionPath, documentId } = parseDocumentPath(path);
    const existing = this.repo.get(path);
    const resolvedData = this.resolveFieldValues(data, existing?.data);

    const isMerge = options !== undefined && ("merge" in options || "mergeFields" in options);
    if (!isMerge && containsDeleteMarker(resolvedData)) {
      // 本家同様、deleteField() は update() または set() の merge オプション時のみ有効
      throw new DocumentValidationError(
        "deleteField() can only be used with update() or set() with {merge: true}",
      );
    }

    let finalData: DocumentData;
    if (options && existing) {
      if ("merge" in options && options.merge) {
        // 本家と同様、ネストしたマップは再帰的にマージする
        finalData = deepMerge(existing.data, resolvedData) as DocumentData;
      } else if ("mergeFields" in options) {
        finalData = structuredClone(existing.data);
        for (const field of options.mergeFields) {
          const value = getFieldByPath(resolvedData, field);
          if (value !== undefined) {
            setFieldByPath(finalData, field, value);
          }
        }
      } else {
        finalData = resolvedData;
      }
    } else {
      finalData = isMerge ? stripDeleteMarkers(resolvedData) : resolvedData;
    }

    // 本家仕様: Timestamp はマイクロ秒精度に切り捨てて保存する
    finalData = truncateTimestampsToMicros(finalData);

    validateDocumentWrite(path, finalData);
    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: finalData,
    });
  }

  addDocument(collectionPath: string, data: DocumentData): DocumentMetadata {
    const documentId = generateDocumentId();
    const path = `${collectionPath}/${documentId}`;
    const resolvedData = truncateTimestampsToMicros(this.resolveFieldValues(data, undefined));

    if (containsDeleteMarker(resolvedData)) {
      throw new DocumentValidationError(
        "deleteField() can only be used with update() or set() with {merge: true}",
      );
    }

    validateDocumentWrite(path, resolvedData);
    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: resolvedData,
    });
  }

  updateDocument(path: string, data: DocumentData): DocumentMetadata {
    const existing = this.repo.get(path);
    if (!existing) {
      throw new DocumentNotFoundError(path);
    }

    const mergedData = structuredClone(existing.data);
    const resolvedUpdates = this.resolveFieldValues(data, existing.data);

    for (const [key, value] of Object.entries(resolvedUpdates)) {
      // deleteField はトップレベル（ドット記法パス含む）でのみ有効（本家と同じ制約）
      if (!isDeleteMarker(value) && containsDeleteMarker(value)) {
        throw new DocumentValidationError(
          `deleteField() can only appear at the top level of update data (field: ${key})`,
        );
      }
      // ドット記法キーはリーフのみ更新する（本家 updateDoc と同じ挙動。
      // 親マップ全体を置換すると兄弟フィールドが消えてしまう）
      setFieldByPath(mergedData, key, value);
    }

    const truncatedData = truncateTimestampsToMicros(mergedData);
    validateDocumentWrite(path, truncatedData);
    const { collectionPath, documentId } = parseDocumentPath(path);
    return this.repo.set({
      path,
      collectionPath,
      documentId,
      data: truncatedData,
    });
  }

  deleteDocument(path: string): boolean {
    return this.repo.delete(path);
  }

  /**
   * FieldValueセンチネルをサーバーサイドで実際の値に解決する
   *
   * ネストしたマップ内のセンチネルや、ドット記法キー（updateDoc の
   * フィールドパス更新）に対する increment / arrayUnion も解決する。
   */
  private resolveFieldValues(
    data: DocumentData,
    existingData: DocumentData | undefined,
  ): DocumentData {
    const resolved: DocumentData = {};

    for (const [key, value] of Object.entries(data)) {
      const existingValue = getFieldByPath(existingData, key);
      resolved[key] = this.resolveValue(value, existingValue);
    }

    return resolved;
  }

  private resolveValue(value: unknown, existingValue: unknown): unknown {
    if (isFieldValueSentinel(value)) {
      switch (value.type) {
        case "serverTimestamp": {
          const now = new Date();
          return {
            __type: "timestamp",
            value: {
              seconds: Math.floor(now.getTime() / 1000),
              nanoseconds: (now.getTime() % 1000) * 1_000_000,
            },
          };
        }
        case "deleteField":
          return DELETE_MARKER;
        case "increment": {
          const current = typeof existingValue === "number" ? existingValue : 0;
          return current + (value.value as number);
        }
        case "arrayUnion": {
          const currentArr = Array.isArray(existingValue) ? existingValue : [];
          const toAdd = value.value as unknown[];
          return [...currentArr, ...toAdd.filter((v) => !currentArr.some((c) => deepEqual(c, v)))];
        }
        case "arrayRemove": {
          const currentArr = Array.isArray(existingValue) ? existingValue : [];
          const toRemove = value.value as unknown[];
          return currentArr.filter((v) => !toRemove.some((r) => deepEqual(r, v)));
        }
      }
    }

    // 特殊型ラッパー（{__type: ...}）の内部には踏み込まない
    // （deleteField マーカーと同じ形式の書き込みデータもここで素通しになるが、
    // マーカーは resolveFieldValues の後段でのみ意味を持つため実害はない）
    if (isSpecialValueWrapper(value)) {
      return value;
    }

    // ネストしたマップ内のセンチネルを再帰的に解決する
    if (isPlainObject(value)) {
      const record = value as Record<string, unknown>;
      const existingRecord = isPlainObject(existingValue)
        ? (existingValue as Record<string, unknown>)
        : undefined;
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) {
        result[k] = this.resolveValue(v, existingRecord?.[k]);
      }
      return result;
    }

    return value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSpecialValueWrapper(value: unknown): boolean {
  return isPlainObject(value) && typeof value.__type === "string";
}

/**
 * setDoc の merge オプション用の深いマージ
 *
 * ネストしたマップは再帰的にマージし、それ以外の値（配列・特殊型を含む）は上書きする。
 * deleteField マーカー（{__type: "delete"}）はフィールドを削除する。
 */
function deepMerge(base: DocumentData, updates: DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(updates)) {
    if (isDeleteMarker(value)) {
      delete result[key];
    } else if (
      isPlainObject(value) &&
      !isSpecialValueWrapper(value) &&
      isPlainObject(result[key]) &&
      !isSpecialValueWrapper(result[key])
    ) {
      result[key] = deepMerge(result[key] as DocumentData, value as DocumentData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Firestore の等値セマンティクスに合わせた深い等値比較 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => deepEqual(a[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** ドット記法パスで既存データから値を取得する */
function getFieldByPath(data: DocumentData | undefined, path: string): unknown {
  if (!data) return undefined;
  if (!path.includes(".")) return data[path];
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * ドット記法パスでリーフ値のみを設定/削除する（本家 updateDoc のフィールドパス更新と同じ挙動）
 */
function setFieldByPath(data: DocumentData, path: string, value: unknown): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = data;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    if (!isPlainObject(current[seg])) {
      if (isDeleteMarker(value)) return; // 存在しないパスの削除は no-op
      current[seg] = {};
    }
    current = current[seg] as Record<string, unknown>;
  }
  const leaf = segments[segments.length - 1];
  if (isDeleteMarker(value)) {
    delete current[leaf];
  } else {
    current[leaf] = value;
  }
}

/** merge set でドキュメントが存在しない場合に deleteField マーカーを取り除く */
function stripDeleteMarkers(data: DocumentData): DocumentData {
  const result: DocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    if (isDeleteMarker(value)) continue;
    if (isPlainObject(value) && !isSpecialValueWrapper(value)) {
      result[key] = stripDeleteMarkers(value as DocumentData);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class DocumentNotFoundError extends Error {
  readonly code: FirestoreErrorCode = "not-found";
  constructor(path: string) {
    super(`Document not found: ${path}`);
    this.name = "DocumentNotFoundError";
  }
}
