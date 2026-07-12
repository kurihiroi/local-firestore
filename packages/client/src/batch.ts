import type {
  BatchOperation,
  DocumentData,
  PartialWithFieldValue,
  SetOptions,
  UpdateData,
  WithFieldValue,
} from "@local-firestore/shared";
import { MAX_WRITE_OPERATIONS } from "@local-firestore/shared";
import { buildUpdateData } from "./crud.js";
import { getLocalStore } from "./local-store.js";
import { serializeData } from "./serialization.js";
import { FirestoreError } from "./transport.js";
import type { DocumentReference, FieldPath, Firestore } from "./types.js";

/** WriteBatchオブジェクトを作成する */
export function writeBatch(firestore: Firestore): WriteBatch {
  return new WriteBatch(firestore);
}

export class WriteBatch {
  private operations: BatchOperation[] = [];
  private committed = false;

  constructor(private firestore: Firestore) {}

  private ensureNotCommitted(): void {
    if (this.committed) {
      throw new FirestoreError("failed-precondition", "WriteBatch has already been committed");
    }
  }

  private ensureCapacity(): void {
    // 本家のハードリミット（500 書き込み / バッチ）をクライアント側で早期検出する
    if (this.operations.length >= MAX_WRITE_OPERATIONS) {
      throw new FirestoreError(
        "invalid-argument",
        `A write batch can contain a maximum of ${MAX_WRITE_OPERATIONS} operations.`,
      );
    }
  }

  set<T = DocumentData>(ref: DocumentReference<T>, data: WithFieldValue<T>): this;
  set<T = DocumentData>(
    ref: DocumentReference<T>,
    data: PartialWithFieldValue<T>,
    options: SetOptions,
  ): this;
  set<T = DocumentData>(
    ref: DocumentReference<T>,
    data: WithFieldValue<T> | PartialWithFieldValue<T>,
    options?: SetOptions,
  ): this {
    this.ensureNotCommitted();
    this.ensureCapacity();
    const dbData = ref._converter
      ? options
        ? ref._converter.toFirestore(data as PartialWithFieldValue<T>, options)
        : ref._converter.toFirestore(data as WithFieldValue<T>)
      : data;
    this.operations.push({
      type: "set",
      path: ref.path,
      data: serializeData(dbData as DocumentData, {
        ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties ?? false,
      }),
      ...(options ? { options } : {}),
    });
    return this;
  }

  update<T = DocumentData>(ref: DocumentReference<T>, data: UpdateData<T>): this;
  update<T = DocumentData>(
    ref: DocumentReference<T>,
    field: string | FieldPath,
    value: unknown,
    ...moreFieldsAndValues: unknown[]
  ): this;
  update<T = DocumentData>(
    ref: DocumentReference<T>,
    dataOrField: UpdateData<T> | string | FieldPath,
    ...moreFieldsAndValues: unknown[]
  ): this {
    this.ensureNotCommitted();
    this.ensureCapacity();
    const raw = buildUpdateData(dataOrField as Record<string, unknown>, moreFieldsAndValues);
    this.operations.push({
      type: "update",
      path: ref.path,
      data: serializeData(raw as DocumentData, {
        ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties ?? false,
      }),
    });
    return this;
  }

  delete<T = DocumentData>(ref: DocumentReference<T>): this {
    this.ensureNotCommitted();
    this.ensureCapacity();
    this.operations.push({
      type: "delete",
      path: ref.path,
    });
    return this;
  }

  async commit(): Promise<void> {
    this.ensureNotCommitted();
    this.committed = true;
    // 1つの mutation としてローカルビューへアトミックに反映し、/batch で送信する
    return getLocalStore(this.firestore).enqueue(
      this.operations.map((op) => ({
        type: op.type,
        path: op.path,
        data: op.data,
        options: op.options,
      })),
      "batch",
    );
  }
}
