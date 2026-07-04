import type {
  BatchOperation,
  DocumentData,
  GetDocumentResponse,
  TransactionBeginResponse,
  TransactionCommitResponse,
  UpdateData,
  WithFieldValue,
} from "@local-firestore/shared";
import { ERROR_CODES } from "@local-firestore/shared";
import { deserializeData, serializeData } from "./serialization.js";
import { QueryDocumentSnapshot } from "./snapshots.js";
import { FirestoreError } from "./transport.js";
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

      const isConflict = e instanceof FirestoreError && e.code === ERROR_CODES.ABORTED;
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

    const data = res.exists ? deserializeData(res.data as DocumentData, this.firestore) : null;

    if (data && ref._converter) {
      const rawSnapshot = new QueryDocumentSnapshot<DocumentData>(
        ref.path,
        ref.id,
        data,
        res.createTime ?? "",
        res.updateTime ?? "",
        ref._firestore,
      );
      const converted = ref._converter.fromFirestore(rawSnapshot);
      return new DocumentSnapshot<T>(ref, converted as T, res.createTime, res.updateTime);
    }

    return new DocumentSnapshot<T>(ref, data as T | null, res.createTime, res.updateTime);
  }

  set<T = DocumentData>(ref: DocumentReference<T>, data: WithFieldValue<T>): this {
    const dbData = ref._converter ? ref._converter.toFirestore(data) : data;
    this.operations.push({
      type: "set",
      path: ref.path,
      data: serializeData(dbData as DocumentData),
    });
    return this;
  }

  update<T = DocumentData>(ref: DocumentReference<T>, data: UpdateData<T>): this {
    this.operations.push({
      type: "update",
      path: ref.path,
      data: serializeData(data as DocumentData),
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
