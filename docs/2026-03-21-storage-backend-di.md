# ストレージバックエンドの DI 設計

## 概要

現在のストレージ層は SQLite にハードカップリングしている。
本ドキュメントでは、Bigtable 等の外部ストレージバックエンドを差し替え可能にするための DI（Dependency Injection）設計を定義する。

---

## 現状の問題点

### 密結合ポイント

```
app.ts: createApp(db: Database.Database)
  ├─ DocumentRepository(db)    ← SQLite prepared statements を直接組み立て
  ├─ QueryService(db)          ← json_extract 等の SQLite 固有関数で動的 SQL 生成
  └─ TransactionService(db)    ← db.transaction() を直接使用 + 内部で Repository を自前生成
```

| ファイル | 結合内容 |
|---|---|
| `storage/repository.ts` | `better-sqlite3` の `Database.Statement` を直接保持 |
| `services/query.ts` | `json_extract()`, `json_each()`, `LIKE` 等の SQLite 固有 SQL を動的生成 |
| `services/transaction.ts` | `db.transaction()` で SQLite トランザクションを直接制御し、内部で `DocumentRepository` を `new` |
| `app.ts` | `Database.Database` を受け取り、全サービスを手動で組み立て |

---

## 設計方針

- **インターフェースでストレージ操作を抽象化**し、SQLite / Bigtable を差し替え可能にする
- Service 層はインターフェースのみに依存し、具象クラスを知らない
- SQL 生成ロジックは SQLite 実装の内部に閉じ込める
- `app.ts` は `StorageBackend` ファクトリを受け取る形に変更する

---

## インターフェース定義

### StorageBackend（ファクトリ）

```typescript
// packages/server/src/storage/interfaces.ts

import type {
  AggregateResultData,
  DocumentData,
  DocumentMetadata,
  SerializedAggregateSpec,
  SerializedQueryConstraint,
} from "@local-firestore/shared";

/**
 * ストレージバックエンド全体を表すファクトリ。
 * アプリケーション起動時に1つ生成し、各サービスに注入する。
 */
export interface StorageBackend {
  readonly documentStore: DocumentStore;
  readonly queryExecutor: QueryExecutor;
  readonly transactionExecutor: TransactionExecutor;

  /** バックエンドの死活チェック */
  healthCheck(): boolean;

  /** リソース解放（タイマー、コネクション等） */
  dispose(): void;
}
```

### DocumentStore（ドキュメント CRUD）

```typescript
/**
 * ドキュメント単体の CRUD 操作。
 * 現在の DocumentRepository に相当する。
 */
export interface DocumentStore {
  get(path: string): DocumentMetadata | undefined;

  set(meta: {
    path: string;
    collectionPath: string;
    documentId: string;
    data: DocumentData;
  }): DocumentMetadata;

  delete(path: string): boolean;

  listCollection(collectionPath: string): DocumentMetadata[];

  listAll(): DocumentMetadata[];

  deleteAll(): number;
}
```

### QueryExecutor（クエリ実行）

```typescript
/**
 * コレクションクエリ・集計クエリの実行。
 * 現在の QueryService から SQL 生成ロジックごとバックエンド側に移動する。
 */
export interface QueryExecutor {
  executeQuery(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    collectionGroup?: boolean,
  ): DocumentMetadata[];

  executeAggregate(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    aggregateSpec: SerializedAggregateSpec,
    collectionGroup?: boolean,
  ): AggregateResultData;
}
```

### TransactionExecutor（トランザクション制御）

```typescript
/**
 * アトミックな操作実行を保証するトランザクション制御。
 * SQLite では db.transaction()、Bigtable ではアプリ層の楽観ロックで実装する。
 */
export interface TransactionExecutor {
  /**
   * コールバック内の操作をアトミックに実行する。
   * SQLite: BEGIN IMMEDIATE ... COMMIT
   * Bigtable: CheckAndMutateRow ベースの楽観ロック
   */
  runTransaction<T>(fn: () => T): T;
}
```

---

## SQLite 実装（既存コードのリファクタ）

### ディレクトリ構成

```
packages/server/src/storage/
├── interfaces.ts                        ← NEW: 上記インターフェース定義
├── sqlite/
│   ├── index.ts                         ← SqliteBackend re-export
│   ├── sqlite-backend.ts               ← StorageBackend 実装
│   ├── sqlite-document-store.ts        ← 現 repository.ts を移動
│   ├── sqlite-query-executor.ts        ← 現 QueryService の SQL 生成部分を移動
│   ├── sqlite-transaction-executor.ts  ← db.transaction() ラッパー
│   ├── sqlite.ts                        ← 既存: createDatabase()
│   └── schema.ts                        ← 既存: initializeSchema()
└── bigtable/
    ├── index.ts
    ├── bigtable-backend.ts
    ├── bigtable-document-store.ts
    ├── bigtable-query-executor.ts
    └── bigtable-transaction-executor.ts
```

### SqliteBackend

```typescript
// packages/server/src/storage/sqlite/sqlite-backend.ts

import type Database from "better-sqlite3";
import type { StorageBackend } from "../interfaces.js";
import { SqliteDocumentStore } from "./sqlite-document-store.js";
import { SqliteQueryExecutor } from "./sqlite-query-executor.js";
import { SqliteTransactionExecutor } from "./sqlite-transaction-executor.js";

export class SqliteBackend implements StorageBackend {
  readonly documentStore: SqliteDocumentStore;
  readonly queryExecutor: SqliteQueryExecutor;
  readonly transactionExecutor: SqliteTransactionExecutor;

  constructor(private db: Database.Database) {
    this.documentStore = new SqliteDocumentStore(db);
    this.queryExecutor = new SqliteQueryExecutor(db);
    this.transactionExecutor = new SqliteTransactionExecutor(db);
  }

  healthCheck(): boolean {
    try {
      const result = this.db.prepare("SELECT 1 AS ok").get() as
        | { ok: number }
        | undefined;
      return result?.ok === 1;
    } catch {
      return false;
    }
  }

  dispose(): void {
    // SQLite は特にリソース解放不要
  }
}
```

### 各実装クラスの対応

| 新クラス | 元のコード | 変更内容 |
|---|---|---|
| `SqliteDocumentStore` | `storage/repository.ts` | `DocumentStore` を `implements`。ロジックはほぼそのまま |
| `SqliteQueryExecutor` | `services/query.ts` | `QueryExecutor` を `implements`。SQL 生成ロジックをそのまま内包 |
| `SqliteTransactionExecutor` | `services/transaction.ts` 内の `db.transaction()` | `TransactionExecutor` を `implements`。`db.transaction()` のラッパー |

---

## Bigtable 実装

### データモデル

Bigtable は行キーベースの KV ストアであり、テーブル設計は以下の通り。

**テーブル: `documents`**

| 項目 | 設計 |
|---|---|
| Row Key | ドキュメントパス（例: `users/alice/posts/post1`） |
| Column Family `d` | ドキュメントデータ |
| Column Family `m` | メタデータ |

```
Row Key: "users/alice/posts/post1"
  d:data     → '{"title":"Hello","body":"..."}'   # JSON 文字列
  m:version  → 3                                    # バージョン番号
  m:cpath    → "users/alice/posts"                  # コレクションパス
  m:did      → "post1"                              # ドキュメント ID
  m:ctime    → "2026-03-21T00:00:00.000Z"           # 作成日時
  m:utime    → "2026-03-21T12:00:00.000Z"           # 更新日時
```

### BigtableDocumentStore

```typescript
// packages/server/src/storage/bigtable/bigtable-document-store.ts

import type { Table } from "@google-cloud/bigtable";
import type { DocumentData, DocumentMetadata } from "@local-firestore/shared";
import type { DocumentStore } from "../interfaces.js";

export class BigtableDocumentStore implements DocumentStore {
  constructor(private table: Table) {}

  get(path: string): DocumentMetadata | undefined {
    // table.row(path).get() で単一行取得
    // Column Family d, m からメタデータを構築
  }

  set(meta: {
    path: string;
    collectionPath: string;
    documentId: string;
    data: DocumentData;
  }): DocumentMetadata {
    // 既存チェック → row.save() で upsert
    // m:version をインクリメント
  }

  delete(path: string): boolean {
    // table.row(path).delete()
  }

  listCollection(collectionPath: string): DocumentMetadata[] {
    // Row Key プレフィックススキャン: prefix = `${collectionPath}/`
    // ただし子コレクションを除外するため m:cpath でフィルタ
    // table.getRows({ prefix: `${collectionPath}/` })
    //   → filter: row => row.m:cpath === collectionPath
  }

  listAll(): DocumentMetadata[] {
    // テーブル全行スキャン（開発・管理用途のみ）
  }

  deleteAll(): number {
    // table.deleteRows({ prefix: '' }) で全行削除
  }
}
```

### BigtableQueryExecutor

Bigtable はセカンダリインデックスを持たないため、クエリ戦略は以下の通り:

```typescript
// packages/server/src/storage/bigtable/bigtable-query-executor.ts

export class BigtableQueryExecutor implements QueryExecutor {
  constructor(private table: Table) {}

  executeQuery(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    collectionGroup = false,
  ): DocumentMetadata[] {
    // 1. 行の取得
    //    - 通常クエリ: prefix scan `${collectionPath}/`
    //    - collectionGroup: フルスキャン + m:cpath フィルタ
    //
    // 2. メモリ上でフィルタリング
    //    - where 条件を JSON パース済みデータに適用
    //
    // 3. メモリ上でソート
    //    - orderBy に従ってソート
    //
    // 4. カーソル・LIMIT 適用
  }

  executeAggregate(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    aggregateSpec: SerializedAggregateSpec,
    collectionGroup = false,
  ): AggregateResultData {
    // executeQuery で結果を取得し、メモリ上で集計
  }
}
```

**パフォーマンス特性の比較:**

| クエリパターン | SQLite | Bigtable |
|---|---|---|
| 単一ドキュメント取得 | O(1) PRIMARY KEY | O(1) Row Key |
| コレクション一覧 | O(n) INDEX SCAN | O(n) Prefix Scan |
| where フィルタ | O(n) SQL WHERE | O(n) Scan + メモリフィルタ |
| collectionGroup | O(n) LIKE | O(N) Full Scan + フィルタ |
| orderBy + limit | O(n log n) SQL | O(n log n) メモリソート |
| count / sum / avg | O(n) SQL 集計 | O(n) Scan + メモリ集計 |

> **注意:** Bigtable で collectionGroup クエリや複雑な where 条件を高速化するには、
> セカンダリインデックステーブル（逆引き用の別 Row Key 設計）が必要になる。
> 本物の Firestore も内部でこの方式を採用している。

### BigtableTransactionExecutor

```typescript
// packages/server/src/storage/bigtable/bigtable-transaction-executor.ts

export class BigtableTransactionExecutor implements TransactionExecutor {
  constructor(private table: Table) {}

  runTransaction<T>(fn: () => T): T {
    // Bigtable はマルチ行トランザクションを直接サポートしない。
    //
    // 方式 A: 単一行 → CheckAndMutateRow (CAS)
    //   row.filter({ ... }).save(trueResult, falseResult)
    //
    // 方式 B: 複数行 → アプリ層の楽観的同時実行制御
    //   1. 読み取り時にバージョンを記録
    //   2. 書き込み時に CheckAndMutateRow でバージョンチェック
    //   3. 競合時は TransactionConflictError を throw
    //
    // 現在の TransactionService の楽観ロック機構をそのまま活用できる。
    // fn() 内の操作をバッファリングし、最後にまとめて CAS 適用する。
    return fn();
  }
}
```

---

## Service 層の変更

### DocumentService

```diff
- import type { DocumentRepository } from "../storage/repository.js";
+ import type { DocumentStore } from "../storage/interfaces.js";

  export class DocumentService {
-   constructor(private repo: DocumentRepository) {}
+   constructor(private store: DocumentStore) {}

    getDocument(path: string): DocumentMetadata | undefined {
-     return this.repo.get(path);
+     return this.store.get(path);
    }

    // 以下同様に repo → store に置換
  }
```

### QueryService

現在の `QueryService` は SQL 生成ロジックを内包しているが、リファクタ後は薄いラッパーになる:

```typescript
export class QueryService {
  constructor(private executor: QueryExecutor) {}

  executeQuery(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    collectionGroup = false,
  ): DocumentMetadata[] {
    return this.executor.executeQuery(collectionPath, constraints, collectionGroup);
  }

  executeAggregate(
    collectionPath: string,
    constraints: SerializedQueryConstraint[],
    aggregateSpec: SerializedAggregateSpec,
    collectionGroup = false,
  ): AggregateResultData {
    return this.executor.executeAggregate(collectionPath, constraints, aggregateSpec, collectionGroup);
  }
}
```

> QueryService がただの委譲になるため、Route 層から直接 `QueryExecutor` を使う選択肢もある。
> ただし将来的にキャッシュやバリデーション等の横断関心事を挟む余地を残すため、Service 層は残す。

### TransactionService

```diff
  export class TransactionService {
-   private repo: DocumentRepository;
-   private docService: DocumentService;
-
-   constructor(private db: Database.Database) {
-     this.repo = new DocumentRepository(db);
-     this.docService = new DocumentService(this.repo);
-   }
+   constructor(
+     private store: DocumentStore,
+     private txExecutor: TransactionExecutor,
+     private docService: DocumentService,
+   ) {}

    commit(transactionId: string, operations: BatchOperation[]): void {
      const txn = this.getActiveTxn(transactionId);

-     const run = this.db.transaction(() => {
+     this.txExecutor.runTransaction(() => {
        for (const [path, readVersion] of txn.reads) {
-         const current = this.repo.get(path);
+         const current = this.store.get(path);
          // ... バージョンチェック
        }
        this.applyOperations(operations);
      });
    }
  }
```

---

## app.ts の変更

```diff
- import type Database from "better-sqlite3";
+ import type { StorageBackend } from "./storage/interfaces.js";

  export function createApp(
-   db: Database.Database,
+   backend: StorageBackend,
    listenerManager?: ListenerManager,
    options?: AppOptions,
  ): Hono {
-   const repo = new DocumentRepository(db);
-   const documentService = new DocumentService(repo);
-   const queryService = new QueryService(db);
-   const transactionService = new TransactionService(db);
+   const documentService = new DocumentService(backend.documentStore);
+   const queryService = new QueryService(backend.queryExecutor);
+   const transactionService = new TransactionService(
+     backend.documentStore,
+     backend.transactionExecutor,
+     documentService,
+   );

    // ヘルスチェック
    app.get("/health", (c) => {
-     const dbOk = isDatabaseHealthy(db);
+     const dbOk = backend.healthCheck();
      // ...
    });

    // データエクスポート・インポート、管理画面
-   app.route("/", createDataRoutes(repo));
-   app.route("/", createAdminRoutes(repo));
+   app.route("/", createDataRoutes(backend.documentStore));
+   app.route("/", createAdminRoutes(backend.documentStore));

    return app;
  }
```

---

## cli.ts でのバックエンド切り替え

```typescript
import { SqliteBackend } from "./storage/sqlite/index.js";
import { BigtableBackend } from "./storage/bigtable/index.js";
import type { StorageBackend } from "./storage/interfaces.js";

const backendType = process.env.STORAGE_BACKEND ?? "sqlite";

let backend: StorageBackend;

if (backendType === "bigtable") {
  backend = new BigtableBackend({
    projectId: process.env.GCP_PROJECT!,
    instanceId: process.env.BIGTABLE_INSTANCE!,
    tableId: process.env.BIGTABLE_TABLE ?? "documents",
  });
} else {
  const db = createDatabase(dbPath);
  initializeSchema(db);
  backend = new SqliteBackend(db);
}

const app = createApp(backend, listenerManager, options);

// シャットダウン時
process.on("SIGTERM", () => {
  backend.dispose();
});
```

---

## 実装ステップ

### Step 1: インターフェース定義

- `storage/interfaces.ts` を新規作成
- `DocumentStore`, `QueryExecutor`, `TransactionExecutor`, `StorageBackend` を定義

### Step 2: SQLite 実装をリファクタ

- `storage/sqlite/` ディレクトリを作成
- 既存の `repository.ts` → `SqliteDocumentStore`（`DocumentStore` を implements）
- 既存の `QueryService` 内の SQL 生成 → `SqliteQueryExecutor`（`QueryExecutor` を implements）
- `db.transaction()` ラッパー → `SqliteTransactionExecutor`
- `SqliteBackend` で3つをまとめる

### Step 3: Service 層をインターフェース依存に変更

- `DocumentService`: `DocumentRepository` → `DocumentStore`
- `QueryService`: `Database.Database` → `QueryExecutor`
- `TransactionService`: `Database.Database` → `DocumentStore` + `TransactionExecutor` + `DocumentService`

### Step 4: app.ts を StorageBackend 受け取りに変更

- `createApp(db)` → `createApp(backend: StorageBackend)`
- ヘルスチェック、data routes、admin routes の依存を更新

### Step 5: テスト修正

- 既存テストは `SqliteBackend` を使うように修正
- インターフェースに対するモックテストを追加（バックエンド差し替えの動作確認）

### Step 6: Bigtable 実装（別 PR）

- `@google-cloud/bigtable` を依存に追加
- `storage/bigtable/` に各クラスを実装
- Bigtable エミュレータを使った統合テスト

---

## Bigtable 固有の注意事項

### クエリパフォーマンス

Bigtable にはセカンダリインデックスがないため、フィールド条件によるクエリはフルスキャンになる。
本番で Bigtable を使う場合、頻出クエリパターンに対して**インデックステーブル**を別途設計する必要がある。

```
# 例: users コレクションの status フィールドでのクエリを高速化
# インデックステーブル: documents_by_field

Row Key: "users#status#active#users/alice"
  → 本体テーブルの Row Key "users/alice" への逆引き

Row Key: "users#status#active#users/bob"
  → 本体テーブルの Row Key "users/bob" への逆引き
```

### トランザクション

Bigtable は単一行の CAS（CheckAndMutateRow）のみネイティブサポート。
複数行にまたがるトランザクションはアプリケーション層での楽観的同時実行制御が必要であり、
現在の `TransactionService` のバージョンチェック機構がそのまま活用できる。

### collectionGroup クエリ

Bigtable の Row Key はプレフィックススキャンのみ効率的。
collectionGroup クエリ（任意の深さの同名コレクションを横断）はフルスキャンが必要。
高速化にはコレクション名をプレフィックスにしたインデックステーブルが必要:

```
# インデックステーブル: documents_by_collection

Row Key: "posts/users/alice/posts/post1"
  → 本体テーブルの "users/alice/posts/post1" を参照
```
