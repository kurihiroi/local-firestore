import type { BatchOperation, BatchResponse, DocumentData } from "@local-firestore/shared";
import type { DocumentReference, Firestore } from "./types.js";

/** WriteBatchオブジェクトを作成する */
export function writeBatch(firestore: Firestore): WriteBatch {
  return new WriteBatch(firestore);
}

export class WriteBatch {
  private operations: BatchOperation[] = [];

  constructor(private firestore: Firestore) {}

  set<T = DocumentData>(ref: DocumentReference<T>, data: T): this {
    this.operations.push({
      type: "set",
      path: ref.path,
      data: data as DocumentData,
    });
    return this;
  }

  update<T = DocumentData>(ref: DocumentReference<T>, data: Partial<T>): this {
    this.operations.push({
      type: "update",
      path: ref.path,
      data: data as DocumentData,
    });
    return this;
  }

  delete<T = DocumentData>(ref: DocumentReference<T>): this {
    this.operations.push({
      type: "delete",
      path: ref.path,
    });
    return this;
  }

  async commit(): Promise<void> {
    const transport = this.firestore._transport;
    await transport.post<BatchResponse>("/batch", {
      operations: this.operations,
    });
  }
}
