import type {
  BatchOperation,
  DocumentMetadata,
  FirestoreErrorCode,
  SerializedQueryConstraint,
  WriteResult,
} from "@local-firestore/shared";
import { createServerMutationContext } from "@local-firestore/shared";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { DocumentRepository } from "../storage/repository.js";
import { DocumentService } from "./document.js";
import { QueryService } from "./query.js";

/** トランザクション有効期限のデフォルト（本家の約 270 秒に準拠） */
const DEFAULT_TRANSACTION_TTL_MS = 270_000;
const CLEANUP_INTERVAL_MS = 60_000;

export interface TransactionServiceOptions {
  /** トランザクションの有効期限（ms）。デフォルト 270_000（本家準拠） */
  ttlMs?: number;
}

/** トランザクション内で実行されたクエリの記録（コミット時の競合検査用） */
interface RecordedQuery {
  collectionPath: string;
  constraints: SerializedQueryConstraint[];
  collectionGroup: boolean;
  /** 実行時の結果フィンガープリント（path → version） */
  results: Map<string, number>;
}

interface TransactionState {
  reads: Map<string, number | null>;
  queries: RecordedQuery[];
  expiresAt: number;
}

export class TransactionService {
  private activeTxns = new Map<string, TransactionState>();
  private conflicts = 0;
  private repo: DocumentRepository;
  private docService: DocumentService;
  private queryService: QueryService;
  private cleanupTimer: ReturnType<typeof setInterval>;
  private ttlMs: number;

  constructor(
    private db: Database.Database,
    options: TransactionServiceOptions = {},
  ) {
    this.repo = new DocumentRepository(db);
    this.docService = new DocumentService(this.repo);
    this.queryService = new QueryService(db);
    this.ttlMs = options.ttlMs ?? DEFAULT_TRANSACTION_TTL_MS;
    this.cleanupTimer = setInterval(() => this.cleanupExpiredTxns(), CLEANUP_INTERVAL_MS);
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
  }

  begin(): string {
    const id = nanoid(20);
    this.activeTxns.set(id, {
      reads: new Map(),
      queries: [],
      expiresAt: Date.now() + this.ttlMs,
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

  /**
   * トランザクション内でクエリを実行し、結果集合を競合検査の対象として記録する。
   *
   * コミット時に同じクエリを再実行し、結果のフィンガープリント（path → version）が
   * 変化していれば aborted にする。結果集合への挿入・削除（ファントム）も検出される。
   */
  query(
    transactionId: string,
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    collectionGroup = false,
  ): DocumentMetadata[] {
    const txn = this.getActiveTxn(transactionId);
    const docs = this.queryService.executeQuery(collectionPath, constraints, collectionGroup);

    txn.queries.push({
      collectionPath,
      constraints,
      collectionGroup,
      results: new Map(docs.map((doc) => [doc.path, doc.version])),
    });

    return docs;
  }

  commit(transactionId: string, operations: BatchOperation[]): WriteResult[] {
    const txn = this.getActiveTxn(transactionId);

    const run = this.db.transaction(() => {
      // 楽観的同時実行制御: 読み取ったドキュメントのバージョンが変わっていないかチェック
      for (const [path, readVersion] of txn.reads) {
        const current = this.repo.get(path);
        const currentVersion = current?.version ?? null;
        if (currentVersion !== readVersion) {
          this.conflicts++;
          throw new TransactionConflictError(path);
        }
      }

      // クエリ競合検査: 記録済みクエリを再実行し、結果集合が変化していないかチェック
      // （結果ドキュメントの更新に加え、挿入・削除によるファントムも検出する）
      for (const recorded of txn.queries) {
        const current = this.queryService.executeQuery(
          recorded.collectionPath,
          recorded.constraints,
          recorded.collectionGroup,
        );
        if (this.queryResultsChanged(recorded.results, current)) {
          this.conflicts++;
          throw new TransactionConflictError(recorded.collectionPath, "query");
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

  /** OCC 競合（aborted）の累計（メトリクス用） */
  get conflictCount(): number {
    return this.conflicts;
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
    // コミット単位でコンテキストを共有し、全オペレーションの serverTimestamp を
    // 単一のコミット時刻に統一する（本家と同じ挙動）
    const context = createServerMutationContext();
    const results: WriteResult[] = [];
    for (const op of operations) {
      switch (op.type) {
        case "set": {
          const meta = this.docService.setDocument(op.path, op.data ?? {}, op.options, context);
          results.push({ path: op.path, createTime: meta.createTime, updateTime: meta.updateTime });
          break;
        }
        case "update": {
          const meta = this.docService.updateDocument(op.path, op.data ?? {}, context);
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

  /** クエリ結果のフィンガープリントが記録時から変化したかどうか */
  private queryResultsChanged(recorded: Map<string, number>, current: DocumentMetadata[]): boolean {
    if (current.length !== recorded.size) {
      return true;
    }
    for (const doc of current) {
      if (recorded.get(doc.path) !== doc.version) {
        return true;
      }
    }
    return false;
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
  constructor(target: string, kind: "document" | "query" = "document") {
    super(
      kind === "query"
        ? `Transaction conflict on query results: ${target}`
        : `Transaction conflict on document: ${target}`,
    );
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
