import type Database from "better-sqlite3";
import { DocumentRepository } from "../storage/repository.js";
import type { CreateDatabaseOptions } from "../storage/sqlite.js";
import { createDatabase } from "../storage/sqlite.js";
import { DocumentService } from "./document.js";
import { ListenerManager } from "./listener-manager.js";
import { QueryService } from "./query.js";

/** デフォルトデータベースのID（本家 Firestore と同じ表記） */
export const DEFAULT_DATABASE_ID = "(default)";

/** データベースIDごとに保持するリソース一式 */
export interface DatabaseInstance {
  databaseId: string;
  db: Database.Database;
  listenerManager: ListenerManager;
  documentService: DocumentService;
}

/**
 * データベースIDのバリデーション
 *
 * 本家 Firestore 準拠: 小文字英数字とハイフン、先頭は英数字、最大63文字。
 * "(default)" は特別扱い。
 */
export function isValidDatabaseId(databaseId: string): boolean {
  if (databaseId === DEFAULT_DATABASE_ID) return true;
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(databaseId);
}

/**
 * データベースIDに対応する SQLite ファイルパスを解決する
 *
 * 例: basePath="local-firestore.db", databaseId="mydb" -> "local-firestore.mydb.db"
 * ":memory:" の場合は各データベースが独立したインメモリDBになる。
 */
export function resolveDatabasePath(basePath: string, databaseId: string): string {
  if (databaseId === DEFAULT_DATABASE_ID) return basePath;
  if (basePath === ":memory:") return ":memory:";
  const dotIndex = basePath.lastIndexOf(".");
  const separatorIndex = Math.max(basePath.lastIndexOf("/"), basePath.lastIndexOf("\\"));
  if (dotIndex > separatorIndex) {
    return `${basePath.slice(0, dotIndex)}.${databaseId}${basePath.slice(dotIndex)}`;
  }
  return `${basePath}.${databaseId}`;
}

/**
 * DatabaseManager - マルチデータベースの管理
 *
 * データベースIDごとに独立した SQLite データベースと関連サービスを
 * 遅延生成して保持する。デフォルトデータベースは registerDefault で
 * 既存のインスタンスを登録できる。
 */
export class DatabaseManager {
  private instances = new Map<string, DatabaseInstance>();

  constructor(
    private basePath: string = ":memory:",
    private databaseOptions: CreateDatabaseOptions = {},
  ) {}

  /** デフォルトデータベースとして既存の DB / ListenerManager を登録する */
  registerDefault(db: Database.Database, listenerManager?: ListenerManager): DatabaseInstance {
    const instance: DatabaseInstance = {
      databaseId: DEFAULT_DATABASE_ID,
      db,
      listenerManager: listenerManager ?? new ListenerManager(new QueryService(db)),
      documentService: new DocumentService(new DocumentRepository(db)),
    };
    this.instances.set(DEFAULT_DATABASE_ID, instance);
    return instance;
  }

  /** データベースIDに対応するインスタンスを取得する（未作成なら生成） */
  get(databaseId: string): DatabaseInstance {
    if (!isValidDatabaseId(databaseId)) {
      throw new Error(`Invalid database ID: "${databaseId}"`);
    }
    const existing = this.instances.get(databaseId);
    if (existing) return existing;

    const db = createDatabase(resolveDatabasePath(this.basePath, databaseId), this.databaseOptions);
    const instance: DatabaseInstance = {
      databaseId,
      db,
      listenerManager: new ListenerManager(new QueryService(db)),
      documentService: new DocumentService(new DocumentRepository(db)),
    };
    this.instances.set(databaseId, instance);
    return instance;
  }

  /** 作成済みかどうか */
  has(databaseId: string): boolean {
    return this.instances.has(databaseId);
  }

  /** 作成済みのデータベースID一覧 */
  databaseIds(): string[] {
    return [...this.instances.keys()];
  }

  /** 作成済みの全インスタンス */
  allInstances(): DatabaseInstance[] {
    return [...this.instances.values()];
  }

  /** 全データベース接続をクローズする */
  closeAll(): void {
    for (const instance of this.instances.values()) {
      instance.db.close();
    }
    this.instances.clear();
  }
}
