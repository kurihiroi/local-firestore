import type {
  BatchOperation,
  DocumentData,
  GetDocumentResponse,
  PartialWithFieldValue,
  SetOptions,
  TransactionBeginResponse,
  TransactionCommitResponse,
  UpdateData,
  WithFieldValue,
} from "@local-firestore/shared";
import { ERROR_CODES, MAX_WRITE_OPERATIONS } from "@local-firestore/shared";
import { buildUpdateData } from "./crud.js";
import { assertNotTerminated } from "./lifecycle.js";
import { deserializeData, serializeData } from "./serialization.js";
import { QueryDocumentSnapshot } from "./snapshots.js";
import { FirestoreError } from "./transport.js";
import type { DocumentReference, Firestore } from "./types.js";
import { DocumentSnapshot, type FieldPath } from "./types.js";

export interface TransactionOptions {
  maxAttempts?: number;
}

/** トランザクションを実行する */
export async function runTransaction<T>(
  firestore: Firestore,
  updateFunction: (transaction: Transaction) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  assertNotTerminated(firestore);
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
      // commit の再送はサーバーで適用済みの書き込みを二重適用しうるため
      // トランスポート層のリトライを無効化する（競合時はここでの
      // aborted リトライがトランザクション全体を再実行する）
      await transport.post<TransactionCommitResponse>(
        "/transaction/commit",
        {
          transactionId,
          operations: transaction._getOperations(),
        },
        { retry: false },
      );
      return result;
    } catch (e) {
      // コンフリクトならリトライ
      await transport.post("/transaction/rollback", { transactionId }).catch(() => {});

      const isConflict = e instanceof FirestoreError && e.code === ERROR_CODES.ABORTED;
      if (isConflict && attempt < maxAttempts - 1) {
        // 本家同様、競合リトライはランダム指数バックオフを挟む
        await backoff(attempt);
        continue;
      }
      throw e;
    }
  }

  throw new Error("Transaction failed after maximum attempts");
}

/** 競合リトライのランダム指数バックオフ（100ms 起点、上限 2 秒、0.5〜1.0 倍で分散） */
function backoff(attempt: number): Promise<void> {
  const base = Math.min(100 * 2 ** attempt, 2000);
  const delay = base * (0.5 + Math.random() * 0.5);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export class Transaction {
  private operations: BatchOperation[] = [];

  constructor(
    private firestore: Firestore,
    private transactionId: string,
  ) {}

  async get<T = DocumentData>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
    // 本家同様、書き込み後の読み取りはエラー（全読み取りは全書き込みより前に行う）
    if (this.operations.length > 0) {
      throw new FirestoreError(
        "invalid-argument",
        "Firestore transactions require all reads to be executed before all writes.",
      );
    }
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

  private ensureCapacity(): void {
    // 本家のハードリミット（500 書き込み / トランザクション）をクライアント側で早期検出する
    if (this.operations.length >= MAX_WRITE_OPERATIONS) {
      throw new FirestoreError(
        "invalid-argument",
        `A transaction can contain a maximum of ${MAX_WRITE_OPERATIONS} write operations.`,
      );
    }
  }

  private serializeOptions() {
    return { ignoreUndefinedProperties: this.firestore._ignoreUndefinedProperties ?? false };
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
    this.ensureCapacity();
    const dbData = ref._converter
      ? options
        ? ref._converter.toFirestore(data as PartialWithFieldValue<T>, options)
        : ref._converter.toFirestore(data as WithFieldValue<T>)
      : data;
    this.operations.push({
      type: "set",
      path: ref.path,
      data: serializeData(dbData as DocumentData, this.serializeOptions()),
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
    this.ensureCapacity();
    const raw = buildUpdateData(dataOrField as Record<string, unknown>, moreFieldsAndValues);
    this.operations.push({
      type: "update",
      path: ref.path,
      data: serializeData(raw as DocumentData, this.serializeOptions()),
    });
    return this;
  }

  delete<T = DocumentData>(ref: DocumentReference<T>): this {
    this.ensureCapacity();
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
