import type {
  BatchOperation,
  DocumentMetadata,
  FirestoreErrorCode,
  WriteResult,
} from "@local-firestore/shared";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { DocumentRepository } from "../storage/repository.js";
import { DocumentService } from "./document.js";

const TRANSACTION_TTL_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60_000;

export class TransactionService {
  private activeTxns = new Map<string, { reads: Map<string, number | null>; expiresAt: number }>();
  private repo: DocumentRepository;
  private docService: DocumentService;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private db: Database.Database) {
    this.repo = new DocumentRepository(db);
    this.docService = new DocumentService(this.repo);
    this.cleanupTimer = setInterval(() => this.cleanupExpiredTxns(), CLEANUP_INTERVAL_MS);
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  begin(): string {
    const id = nanoid(20);
    this.activeTxns.set(id, {
      reads: new Map(),
      expiresAt: Date.now() + TRANSACTION_TTL_MS,
    });
    return id;
  }

  getDocument(transactionId: string, path: string): DocumentMetadata | undefined {
    const txn = this.getActiveTxn(transactionId);
    const doc = this.repo.get(path);

    // 読み取ったドキュメントのバージョンを記録
    txn.reads.set(path, doc?.version ?? null);

    return doc;
  }

  commit(transactionId: string, operations: BatchOperation[]): WriteResult[] {
    const txn = this.getActiveTxn(transactionId);

    const run = this.db.transaction(() => {
      // 楽観的同時実行制御: 読み取ったドキュメントのバージョンが変わっていないかチェック
      for (const [path, readVersion] of txn.reads) {
        const current = this.repo.get(path);
        const currentVersion = current?.version ?? null;
        if (currentVersion !== readVersion) {
          throw new TransactionConflictError(path);
        }
      }

      return this.applyOperations(operations);
    });

    try {
      return run();
    } finally {
      this.activeTxns.delete(transactionId);
    }
  }

  rollback(transactionId: string): void {
    this.activeTxns.delete(transactionId);
  }

  executeBatch(operations: BatchOperation[]): WriteResult[] {
    const run = this.db.transaction(() => {
      return this.applyOperations(operations);
    });
    return run();
  }

  /** 各オペレーションを適用し、書き込み結果（確定した create/updateTime）を返す */
  private applyOperations(operations: BatchOperation[]): WriteResult[] {
    const results: WriteResult[] = [];
    for (const op of operations) {
      switch (op.type) {
        case "set": {
          const meta = this.docService.setDocument(op.path, op.data ?? {});
          results.push({ path: op.path, createTime: meta.createTime, updateTime: meta.updateTime });
          break;
        }
        case "update": {
          const meta = this.docService.updateDocument(op.path, op.data ?? {});
          results.push({ path: op.path, createTime: meta.createTime, updateTime: meta.updateTime });
          break;
        }
        case "delete":
          this.docService.deleteDocument(op.path);
          results.push({ path: op.path });
          break;
        default: {
          const _exhaustive: never = op.type;
          throw new Error(`Unknown operation type: ${_exhaustive}`);
        }
      }
    }
    return results;
  }

  private getActiveTxn(transactionId: string) {
    const txn = this.activeTxns.get(transactionId);
    if (!txn) {
      throw new TransactionNotFoundError(transactionId);
    }
    if (Date.now() > txn.expiresAt) {
      this.activeTxns.delete(transactionId);
      throw new TransactionExpiredError(transactionId);
    }
    return txn;
  }

  private cleanupExpiredTxns(): void {
    const now = Date.now();
    for (const [id, txn] of this.activeTxns) {
      if (now > txn.expiresAt) {
        this.activeTxns.delete(id);
      }
    }
  }
}

export class TransactionConflictError extends Error {
  readonly code: FirestoreErrorCode = "aborted";
  constructor(path: string) {
    super(`Transaction conflict on document: ${path}`);
    this.name = "TransactionConflictError";
  }
}

export class TransactionNotFoundError extends Error {
  readonly code: FirestoreErrorCode = "not-found";
  constructor(transactionId: string) {
    super(`Transaction not found: ${transactionId}`);
    this.name = "TransactionNotFoundError";
  }
}

export class TransactionExpiredError extends Error {
  readonly code: FirestoreErrorCode = "deadline-exceeded";
  constructor(transactionId: string) {
    super(`Transaction expired: ${transactionId}`);
    this.name = "TransactionExpiredError";
  }
}
