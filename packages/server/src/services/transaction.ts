import type { BatchOperation, DocumentMetadata } from "@local-firestore/shared";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { DocumentRepository } from "../storage/repository.js";
import { DocumentService } from "./document.js";

export class TransactionService {
  private activeTxns = new Map<string, { reads: Map<string, number | null>; expiresAt: number }>();

  constructor(private db: Database.Database) {}

  begin(): string {
    const id = nanoid(20);
    this.activeTxns.set(id, {
      reads: new Map(),
      expiresAt: Date.now() + 30_000, // 30秒で期限切れ
    });
    return id;
  }

  getDocument(transactionId: string, path: string): DocumentMetadata | undefined {
    const txn = this.getActiveTxn(transactionId);
    const repo = new DocumentRepository(this.db);
    const doc = repo.get(path);

    // 読み取ったドキュメントのバージョンを記録
    txn.reads.set(path, doc?.version ?? null);

    return doc;
  }

  commit(transactionId: string, operations: BatchOperation[]): void {
    const txn = this.getActiveTxn(transactionId);

    // SQLiteトランザクション内で実行
    const run = this.db.transaction(() => {
      const repo = new DocumentRepository(this.db);
      const docService = new DocumentService(repo);

      // 楽観的同時実行制御: 読み取ったドキュメントのバージョンが変わっていないかチェック
      for (const [path, readVersion] of txn.reads) {
        const current = repo.get(path);
        const currentVersion = current?.version ?? null;
        if (currentVersion !== readVersion) {
          throw new TransactionConflictError(path);
        }
      }

      // 操作を実行
      for (const op of operations) {
        switch (op.type) {
          case "set":
            docService.setDocument(op.path, op.data ?? {});
            break;
          case "update":
            docService.updateDocument(op.path, op.data ?? {});
            break;
          case "delete":
            docService.deleteDocument(op.path);
            break;
        }
      }
    });

    try {
      run();
    } finally {
      this.activeTxns.delete(transactionId);
    }
  }

  rollback(transactionId: string): void {
    this.activeTxns.delete(transactionId);
  }

  executeBatch(operations: BatchOperation[]): void {
    const run = this.db.transaction(() => {
      const repo = new DocumentRepository(this.db);
      const docService = new DocumentService(repo);

      for (const op of operations) {
        switch (op.type) {
          case "set":
            docService.setDocument(op.path, op.data ?? {});
            break;
          case "update":
            docService.updateDocument(op.path, op.data ?? {});
            break;
          case "delete":
            docService.deleteDocument(op.path);
            break;
        }
      }
    });

    run();
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
}

export class TransactionConflictError extends Error {
  readonly code = "aborted";
  constructor(path: string) {
    super(`Transaction conflict on document: ${path}`);
    this.name = "TransactionConflictError";
  }
}

export class TransactionNotFoundError extends Error {
  readonly code = "not-found";
  constructor(transactionId: string) {
    super(`Transaction not found: ${transactionId}`);
    this.name = "TransactionNotFoundError";
  }
}

export class TransactionExpiredError extends Error {
  readonly code = "deadline-exceeded";
  constructor(transactionId: string) {
    super(`Transaction expired: ${transactionId}`);
    this.name = "TransactionExpiredError";
  }
}
