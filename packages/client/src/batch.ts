import type {
  BatchOperation,
  BatchResponse,
  DocumentData,
  WithFieldValue,
} from "@local-firestore/shared";
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
      throw new Error("WriteBatch has already been committed");
    }
  }

  set<T = DocumentData>(ref: DocumentReference<T>, data: WithFieldValue<T>): this {
    this.ensureNotCommitted();
    const dbData = ref._converter ? ref._converter.toFirestore(data) : data;
    this.operations.push({
      type: "set",
      path: ref.path,
      data: dbData as DocumentData,
    });
    return this;
  }

  update<T = DocumentData>(ref: DocumentReference<T>, data: Partial<T>): this {
    this.ensureNotCommitted();
    this.operations.push({
      type: "update",
      path: ref.path,
      data: data as DocumentData,
    });
    return this;
  }

  delete<T = DocumentData>(ref: DocumentReference<T>): this {
    this.ensureNotCommitted();
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
