import type {
  BatchOperation,
  DocumentData,
  GetDocumentResponse,
  TransactionBeginResponse,
  TransactionCommitResponse,
} from "@local-firestore/shared";
import { ERROR_CODES } from "@local-firestore/shared";
import type { DocumentReference, Firestore } from "./types.js";
import { DocumentSnapshot } from "./types.js";

export interface TransactionOptions {
  maxAttempts?: number;
}

/** トランザクションを実行する */
export async function runTransaction<T>(
  firestore: Firestore,
  updateFunction: (transaction: Transaction) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 5;
  const transport = firestore._transport;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { transactionId } = await transport.post<TransactionBeginResponse>(
      "/transaction/begin",
      {},
    );

    const transaction = new Transaction(firestore, transactionId);

    try {
      const result = await updateFunction(transaction);
      await transport.post<TransactionCommitResponse>("/transaction/commit", {
        transactionId,
        operations: transaction._getOperations(),
      });
      return result;
    } catch (e) {
      // コンフリクトならリトライ
      await transport.post("/transaction/rollback", { transactionId }).catch(() => {});

      const isConflict =
        e instanceof Error && "code" in e && (e as { code: string }).code === ERROR_CODES.ABORTED;
      if (isConflict && attempt < maxAttempts - 1) {
        continue;
      }
      throw e;
    }
  }

  throw new Error("Transaction failed after maximum attempts");
}

export class Transaction {
  private operations: BatchOperation[] = [];

  constructor(
    private firestore: Firestore,
    private transactionId: string,
  ) {}

  async get<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
    const transport = this.firestore._transport;
    const res = await transport.post<GetDocumentResponse>("/transaction/get", {
      transactionId: this.transactionId,
      path: ref.path,
    });

    return new DocumentSnapshot<T>(
      ref,
      res.exists ? (res.data as T) : null,
      res.createTime,
      res.updateTime,
    );
  }

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

  /** @internal */
  _getOperations(): BatchOperation[] {
    return this.operations;
  }
}
