import type {
  BatchOperation,
  BatchResponse,
  DocumentData,
  UpdateData,
  WithFieldValue,
} from "@local-firestore/shared";
import { MAX_WRITE_OPERATIONS } from "@local-firestore/shared";
import { serializeData } from "./serialization.js";
import { FirestoreError } from "./transport.js";
import type { DocumentReference, Firestore } from "./types.js";

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

  set<T = DocumentData>(ref: DocumentReference<T>, data: WithFieldValue<T>): this {
    this.ensureNotCommitted();
    this.ensureCapacity();
    const dbData = ref._converter ? ref._converter.toFirestore(data) : data;
    this.operations.push({
      type: "set",
      path: ref.path,
      data: serializeData(dbData as DocumentData, {
        ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties ?? false,
      }),
    });
    return this;
  }

  update<T = DocumentData>(ref: DocumentReference<T>, data: UpdateData<T>): this {
    this.ensureNotCommitted();
    this.ensureCapacity();
    this.operations.push({
      type: "update",
      path: ref.path,
      data: serializeData(data as DocumentData, {
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
    const transport = this.firestore._transport;
    await transport.post<BatchResponse>("/batch", {
      operations: this.operations,
    });
  }
}
