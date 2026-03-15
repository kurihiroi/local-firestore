# Local Firestore クローン アーキテクチャ設計

## 前提

- Web Modular SDK (v9+) 互換のAPIを提供する
- TypeScript で実装する
- ストレージは SQLite（`better-sqlite3`）を使用する
- 段階的に機能を拡張していく

---

## 暫定的な緩和事項（完成時に修正予定）

以下の項目は開発初期フェーズにおいて一時的に緩和している。全Phase完了時に厳格化する。

| 項目 | 現在の状態 | 完成時の対応 |
|---|---|---|
| Biome `noNonNullAssertion` | `off` | `error` に戻す。テストコードでは型ガード付きアサーションに置き換える |
| Biome `noUnusedPrivateClassMembers` | `off` | `error` に戻す。不要なprivateメンバーを削除する |
| 未使用ジェネリクス型パラメータ（`Query<T>`, `CollectionReference<T>`） | `biome-ignore` で抑制 | 型パラメータを実際に使用する実装を入れた上で `biome-ignore` を削除する |
| TypeScript `composite` / project references | 未使用（tsconfig.jsonから削除済み） | 全パッケージのビルドが安定したら再導入を検討する |

---

## 全体構成

```
┌─────────────────────────────────────────────────┐
│                 Client App                       │
│          (既存の Firebase アプリコード)             │
└────────────────────┬────────────────────────────┘
                     │ import
┌────────────────────▼────────────────────────────┐
│              Client SDK Layer                    │
│  firebase/firestore 互換の Modular API           │
│                                                  │
│  getFirestore, doc, collection, getDoc, setDoc,  │
│  query, where, onSnapshot, writeBatch, ...       │
│                                                  │
│  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ HTTP Client  │  │ WebSocket Client        │  │
│  │ (CRUD/Query) │  │ (Real-time Listeners)   │  │
│  └──────┬───────┘  └──────────┬──────────────┘  │
└─────────┼─────────────────────┼─────────────────┘
          │ HTTP                │ WebSocket
┌─────────▼─────────────────────▼─────────────────┐
│                  Server                          │
│  ┌──────────────────────────────────────────┐    │
│  │          Transport Layer                 │    │
│  │  ┌────────────┐  ┌───────────────────┐   │    │
│  │  │ HTTP Router│  │ WebSocket Server  │   │    │
│  │  └─────┬──────┘  └────────┬──────────┘   │    │
│  └────────┼──────────────────┼──────────────┘    │
│           │                  │                   │
│  ┌────────▼──────────────────▼──────────────┐    │
│  │          Service Layer                   │    │
│  │  ┌──────────────┐  ┌─────────────────┐   │    │
│  │  │ Document     │  │ Query           │   │    │
│  │  │ Service      │  │ Service         │   │    │
│  │  ├──────────────┤  ├─────────────────┤   │    │
│  │  │ Transaction  │  │ Listener        │   │    │
│  │  │ Service      │  │ Manager         │   │    │
│  │  └──────┬───────┘  └────────┬────────┘   │    │
│  └─────────┼───────────────────┼────────────┘    │
│            │                   │                 │
│  ┌─────────▼───────────────────▼────────────┐    │
│  │          Storage Layer                   │    │
│  │  ┌──────────────────────────────────┐    │    │
│  │  │ SQLite (better-sqlite3)          │    │    │
│  │  │ WAL mode / 同期API              │    │    │
│  │  └──────────────────────────────────┘    │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

---

## レイヤー詳細

### 1. Client SDK Layer

Firebase Web Modular SDK (v9+) と同じAPIシグネチャを持つクライアントライブラリ。
ユーザーは `firebase/firestore` の代わりにこのパッケージを import するだけで切り替えられる。

```typescript
// 利用イメージ
import {
  getFirestore, doc, collection, getDoc, setDoc,
  query, where, onSnapshot
} from 'local-firestore/client';

const db = getFirestore({ host: 'localhost', port: 8080 });
const docRef = doc(db, 'users', 'alice');
await setDoc(docRef, { name: 'Alice', age: 30 });
```

**内部構成:**

| モジュール | 役割 |
|---|---|
| `references.ts` | `doc()`, `collection()`, `collectionGroup()` — パス解決とリファレンスオブジェクト生成 |
| `crud.ts` | `getDoc()`, `getDocs()`, `addDoc()`, `setDoc()`, `updateDoc()`, `deleteDoc()` — HTTP経由でサーバーにリクエスト |
| `query.ts` | `query()`, `where()`, `orderBy()`, `limit()`, `startAt()` 等 — クエリ制約をシリアライズしてサーバーに送信 |
| `batch.ts` | `writeBatch()` — バッチ操作をまとめてサーバーに送信 |
| `transaction.ts` | `runTransaction()` — トランザクションセッション管理 |
| `listener.ts` | `onSnapshot()` — WebSocket接続でリアルタイム更新を受信 |
| `field-values.ts` | `serverTimestamp()`, `increment()`, `arrayUnion()`, `arrayRemove()`, `deleteField()` — センチネル値生成 |
| `types.ts` | `Timestamp`, `GeoPoint`, `Bytes`, `FieldPath`, スナップショット型 等 |
| `transport.ts` | HTTP / WebSocket クライアントの抽象化 |

### 2. Transport Layer

クライアントとサーバー間の通信を担当する。

**HTTP API（CRUD / クエリ / バッチ / トランザクション）:**

| メソッド | エンドポイント | 用途 |
|---|---|---|
| `GET` | `/docs/:path` | ドキュメント取得 |
| `POST` | `/docs` | ドキュメント作成（addDoc） |
| `PUT` | `/docs/:path` | ドキュメント作成/上書き（setDoc） |
| `PATCH` | `/docs/:path` | ドキュメント更新（updateDoc） |
| `DELETE` | `/docs/:path` | ドキュメント削除 |
| `POST` | `/query` | クエリ実行 |
| `POST` | `/batch` | バッチ書き込み |
| `POST` | `/transaction/begin` | トランザクション開始 |
| `POST` | `/transaction/commit` | トランザクションコミット |
| `POST` | `/transaction/rollback` | トランザクションロールバック |
| `POST` | `/aggregate` | 集計クエリ |

**WebSocket（リアルタイムリスナー）:**

| メッセージタイプ | 方向 | 用途 |
|---|---|---|
| `subscribe_doc` | Client → Server | ドキュメントリスナー登録 |
| `subscribe_query` | Client → Server | クエリリスナー登録 |
| `unsubscribe` | Client → Server | リスナー解除 |
| `snapshot` | Server → Client | スナップショット通知 |
| `error` | Server → Client | エラー通知 |

### 3. Service Layer

ビジネスロジックを担当する。

#### Document Service

- ドキュメントのCRUD処理
- パスの検証（コレクション/ドキュメントの交互チェック）
- FieldValue のサーバーサイド解決
  - `serverTimestamp()` → 現在時刻に展開
  - `increment(n)` → 既存値 + n に展開
  - `arrayUnion(...)` → 既存配列とのマージ
  - `arrayRemove(...)` → 既存配列からの除去
  - `deleteField()` → フィールド削除
- ドキュメントID自動生成（`addDoc` 時）
- `set` with `merge` / `mergeFields` のマージロジック
- 書き込み後に Listener Manager へ変更通知

#### Query Service

- Firestore クエリ制約を SQL に変換
- JSON フィールドへのクエリ（SQLite `json_extract()`）
- 複合フィルタ（`and` / `or`）の構築
- ソート・ページネーション・カーソルの処理
- コレクショングループクエリの実行

**クエリ変換例:**

```typescript
// Firestore クエリ
query(
  collection(db, 'users'),
  where('age', '>=', 18),
  where('status', '==', 'active'),
  orderBy('age', 'asc'),
  limit(10)
)

// 生成される SQL
SELECT * FROM documents
WHERE collection_path = 'users'
  AND json_extract(data, '$.age') >= 18
  AND json_extract(data, '$.status') = 'active'
ORDER BY json_extract(data, '$.age') ASC
LIMIT 10
```

#### Transaction Service

- トランザクションセッションの管理
- 楽観的同時実行制御（読み取り時のバージョンチェック）
- 最大リトライ回数の制御（デフォルト5回）
- トランザクション内での読み取り→書き込みの整合性保証

**トランザクションフロー:**

```
Client                    Server
  │                         │
  │── begin ──────────────→│  トランザクションID発行
  │                         │  SQLite BEGIN IMMEDIATE
  │                         │
  │── get(docRef) ────────→│  ドキュメント読み取り
  │←─ snapshot ────────────│  + バージョン記録
  │                         │
  │── set(docRef, data) ──→│  書き込みバッファに蓄積
  │                         │
  │── commit ─────────────→│  バージョン競合チェック
  │                         │  競合なし → COMMIT
  │←─ success ─────────────│  競合あり → ROLLBACK + リトライ
```

#### Listener Manager

- アクティブなリスナー（WebSocket接続 + サブスクリプション）の管理
- ドキュメント変更時の影響範囲判定
- 該当するリスナーへのスナップショット配信
- `DocumentChangeType`（`added` / `modified` / `removed`）の判定

**変更通知フロー:**

```
Document Service
  │
  │── 書き込み完了
  │
  ▼
Listener Manager
  │
  ├── 変更されたドキュメントパスに一致するリスナーを検索
  ├── クエリリスナー: 変更後のドキュメントがクエリ条件に一致するか再評価
  │
  ▼
WebSocket Server
  │
  └── 該当クライアントに snapshot メッセージ送信
```

### 4. Storage Layer（SQLite）

#### SQLite 設定

```typescript
const db = new Database('local-firestore.db');
db.pragma('journal_mode = WAL');       // 読み書き並行性向上
db.pragma('synchronous = NORMAL');     // パフォーマンスと安全性のバランス
db.pragma('foreign_keys = ON');        // 外部キー制約有効化
db.pragma('busy_timeout = 5000');      // ロック待ちタイムアウト
```

#### テーブル設計

```sql
-- ドキュメントストア
CREATE TABLE documents (
  path            TEXT PRIMARY KEY,       -- 'users/alice', 'users/alice/posts/post1'
  collection_path TEXT NOT NULL,          -- 'users', 'users/alice/posts'
  document_id     TEXT NOT NULL,          -- 'alice', 'post1'
  data            TEXT NOT NULL,          -- JSON文字列
  version         INTEGER NOT NULL DEFAULT 1,
  create_time     TEXT NOT NULL,          -- ISO 8601
  update_time     TEXT NOT NULL           -- ISO 8601
);

-- コレクション単位のクエリ高速化
CREATE INDEX idx_documents_collection
  ON documents(collection_path);

-- コレクショングループクエリ用（末尾のコレクション名で検索）
CREATE INDEX idx_documents_collection_group
  ON documents(document_id, collection_path);

-- トランザクション管理
CREATE TABLE transactions (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active', 'committed', 'aborted'
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

-- トランザクションで読み取ったドキュメントのバージョン記録
CREATE TABLE transaction_reads (
  transaction_id  TEXT NOT NULL REFERENCES transactions(id),
  document_path   TEXT NOT NULL,
  read_version    INTEGER,                -- NULL = ドキュメント未存在時の読み取り
  PRIMARY KEY (transaction_id, document_path)
);
```

#### JSON データ格納とクエリ

SQLite の JSON 関数を活用してドキュメントフィールドを直接クエリする。

```sql
-- フィールド抽出
json_extract(data, '$.name')              -- → 'Alice'
json_extract(data, '$.address.city')      -- → ネストフィールド対応

-- 型判定
json_type(data, '$.age')                  -- → 'integer'

-- 配列操作（array-contains）
EXISTS (
  SELECT 1 FROM json_each(json_extract(data, '$.tags'))
  WHERE value = 'typescript'
)

-- array-contains-any
EXISTS (
  SELECT 1 FROM json_each(json_extract(data, '$.tags'))
  WHERE value IN ('typescript', 'javascript')
)

-- in クエリ
json_extract(data, '$.status') IN ('active', 'pending')
```

#### Firestore データ型の SQLite JSON マッピング

Firestore のデータ型はすべて JSON にシリアライズして格納する。
プリミティブ型はそのまま、特殊型はメタデータ付きオブジェクトとして格納する。

```typescript
// 格納形式
interface SerializedValue {
  __type: 'timestamp' | 'geopoint' | 'bytes' | 'reference';
  value: any;
}

// 例
{
  name: "Alice",                                          // string → そのまま
  age: 30,                                                // number → そのまま
  active: true,                                           // boolean → そのまま
  tags: ["ts", "node"],                                   // array → そのまま
  address: { city: "Tokyo" },                             // map → そのまま
  createdAt: { __type: "timestamp", value: { seconds: 1710000000, nanoseconds: 0 } },
  location: { __type: "geopoint", value: { latitude: 35.68, longitude: 139.76 } },
  avatar: { __type: "bytes", value: "base64encoded..." },
  ref: { __type: "reference", value: "users/bob" }
}
```

---

## 技術スタック

### プロダクション依存

| 用途 | ライブラリ |
|---|---|
| HTTP サーバー | [Hono](https://hono.dev/) — 軽量・高速・TypeScriptファースト |
| WebSocket | [ws](https://github.com/websockets/ws) — Node.js 定番 |
| SQLite | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — 同期API・高速 |
| ID 生成 | [nanoid](https://github.com/ai/nanoid) — 短い一意ID |
| バリデーション | [zod](https://zod.dev/) — リクエスト/データバリデーション |
| ランタイム | Node.js 20+ |

### 開発環境

| 用途 | ツール |
|---|---|
| パッケージマネージャ | [pnpm](https://pnpm.io/) — monorepo対応、ディスク効率◎ |
| Lint / Format | [Biome](https://biomejs.dev/) — Lint + Format一体型、高速 |
| テスト | [Vitest](https://vitest.dev/) — TypeScriptネイティブ、高速 |
| ビルド | [tsup](https://tsup.egoist.dev/) — esbuildベース、ライブラリ向き |
| CI | GitHub Actions |

---

## 段階的実装計画

### Phase 1: コア基盤

**目標:** ドキュメントの基本的なCRUDが動く

- サーバー起動（Hono + SQLite 初期化）
- Client SDK の基本構造（`getFirestore`, `doc`, `collection`）
- `setDoc` / `getDoc` / `deleteDoc` / `addDoc`
- `Timestamp`, `DocumentReference`, `DocumentSnapshot` 型
- 基本的な `FieldValue`（`serverTimestamp`, `deleteField`）

### Phase 2: クエリエンジン

**目標:** コレクション内のドキュメントを条件付きで取得できる

- `getDocs` + `query()` + `where()` （等価・比較フィルタ）
- `orderBy` / `limit` / `limitToLast`
- `startAt` / `startAfter` / `endAt` / `endBefore`
- `array-contains` / `in` / `not-in` / `array-contains-any`
- `and()` / `or()` 複合フィルタ
- コレクショングループクエリ

### Phase 3: バッチ・トランザクション

**目標:** 複数ドキュメントのアトミック操作ができる

- `writeBatch` （set / update / delete → commit）
- `runTransaction` （楽観的同時実行制御）
- `updateDoc` の完全実装（FieldPath, ネストフィールド更新）
- `increment` / `arrayUnion` / `arrayRemove`

### Phase 4: リアルタイムリスナー

**目標:** `onSnapshot` でリアルタイム更新を受信できる

- WebSocket サーバー起動
- ドキュメントリスナー（`onSnapshot` on DocumentReference）
- クエリリスナー（`onSnapshot` on Query）
- `DocumentChange` の `added` / `modified` / `removed` 判定
- `Unsubscribe` 処理

**現時点の制限事項:**

- WebSocket 切断時の自動再接続・再サブスクライブは未実装
- オフライン時の書き込みキューイング（オンライン復帰後の自動送信）は未対応
- クライアント側のスナップショットキャッシュなし（常にサーバーから取得）

### Phase 5: 拡張機能

**目標:** 実用レベルの機能を揃える

- 集計クエリ（`count`, `sum`, `average`）
- `set` with `merge` / `mergeFields`
- `GeoPoint` / `Bytes` 型のフルサポート
- `FirestoreDataConverter`（`withConverter`）
- エラーハンドリング（`FirestoreErrorCode` 互換のエラー）
- データのエクスポート / インポート

### Phase 6: 運用機能

**目標:** 実運用に耐える品質

- Web UI（データ閲覧・編集）
- ログ出力
- ヘルスチェック / メトリクス
- TLS 対応
- セキュリティルールエンジン

### Phase 7: 接続の安定性とオフライン対応

**目標:** WebSocket 接続の信頼性を高め、ネットワーク断に対応する

- WebSocket 切断時の自動再接続（指数バックオフ付きリトライ）
- 再接続時のサブスクリプション自動再登録
- オフライン時の書き込みキューイング（オンライン復帰後に自動送信）
- クライアント側スナップショットキャッシュ（オフライン中の読み取り対応）
- 接続状態の通知（`onSnapshotsInSync` 対応）

---

## ディレクトリ構成（想定）

```
local-firestore/
├── packages/
│   ├── client/                  # Client SDK
│   │   ├── src/
│   │   │   ├── index.ts         # 公開API re-export
│   │   │   ├── firestore.ts     # getFirestore, initializeFirestore
│   │   │   ├── references.ts    # doc, collection, collectionGroup
│   │   │   ├── crud.ts          # getDoc, setDoc, addDoc, updateDoc, deleteDoc
│   │   │   ├── query.ts         # query, where, orderBy, limit, ...
│   │   │   ├── batch.ts         # writeBatch
│   │   │   ├── transaction.ts   # runTransaction
│   │   │   ├── listener.ts      # onSnapshot
│   │   │   ├── field-values.ts  # serverTimestamp, increment, ...
│   │   │   ├── types.ts         # Timestamp, GeoPoint, Bytes, FieldPath, ...
│   │   │   ├── snapshots.ts     # DocumentSnapshot, QuerySnapshot, ...
│   │   │   └── transport.ts     # HTTP / WebSocket 通信
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── server/                  # Server
│   │   ├── src/
│   │   │   ├── index.ts         # サーバー起動エントリ
│   │   │   ├── app.ts           # Hono アプリケーション定義
│   │   │   ├── routes/
│   │   │   │   ├── documents.ts # CRUD エンドポイント
│   │   │   │   ├── query.ts     # クエリエンドポイント
│   │   │   │   ├── batch.ts     # バッチエンドポイント
│   │   │   │   └── transaction.ts
│   │   │   ├── services/
│   │   │   │   ├── document.ts  # Document Service
│   │   │   │   ├── query.ts     # Query Service
│   │   │   │   ├── transaction.ts
│   │   │   │   └── listener.ts  # Listener Manager
│   │   │   ├── storage/
│   │   │   │   ├── sqlite.ts    # SQLite 接続・初期化
│   │   │   │   ├── schema.ts    # テーブル定義
│   │   │   │   └── repository.ts # データアクセス層
│   │   │   ├── websocket/
│   │   │   │   └── handler.ts   # WebSocket メッセージハンドラ
│   │   │   └── utils/
│   │   │       ├── id.ts        # ID生成
│   │   │       ├── path.ts      # パスユーティリティ
│   │   │       └── serialize.ts # データ型シリアライズ
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── shared/                  # 共有型・定数
│       ├── src/
│       │   ├── types.ts         # 共有型定義
│       │   └── protocol.ts     # 通信プロトコル定義
│       ├── package.json
│       └── tsconfig.json
│
├── docs/
├── .github/
│   └── workflows/
│       └── ci.yml               # CI パイプライン
├── biome.json                   # Biome 設定（Lint + Format）
├── package.json                 # monorepo ルート
├── tsconfig.json                # 共通 TypeScript 設定
├── tsconfig.build.json          # ビルド用 TypeScript 設定
└── pnpm-workspace.yaml
```

---

## 開発環境設計

### Biome 設定方針

ルートに `biome.json` を1つ置き、monorepo全体に適用する。

```jsonc
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedVariables": "error",
        "noUnusedImports": "error"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
```

### Vitest 設定方針

各パッケージに `vitest.config.ts` を配置。ルートから `pnpm test` で全パッケージのテストを一括実行。

```typescript
// packages/server/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
});
```

### テスト戦略

| テスト種別 | 対象 | 配置 | 実行タイミング |
|---|---|---|---|
| **ユニットテスト** | 個別関数・クラス | `*.test.ts`（対象ファイルと同階層） | CI + ローカル |
| **統合テスト** | サーバーAPI + SQLite | `packages/server/src/**/*.test.ts` | CI + ローカル |
| **E2Eテスト** | Client SDK → Server 一連のフロー | `packages/e2e/` | CI |

**テスト方針:**
- SQLiteはインメモリ（`:memory:`）でテスト実行 → 高速 & クリーンアップ不要
- サーバーのAPIテストは Hono の `app.request()` を使い、実際のHTTPサーバーを立てずにテスト
- E2Eテストではサーバーを起動し、Client SDKから実際に接続してテスト

### tsup ビルド設定

各パッケージで `tsup.config.ts` を配置。ESM + CJS のデュアルフォーマットで出力。

```typescript
// packages/client/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,                    // 型定義ファイル生成
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});
```

### package.json の公開設定

npm公開時に利用者がESM/CJSどちらでも使えるように `exports` フィールドを設定する。

```jsonc
// packages/client/package.json
{
  "name": "@local-firestore/client",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "lint:fix": "biome check --fix .",
    "format": "biome format --write ."
  }
}
```

### pnpm ルート scripts

```jsonc
// package.json (root)
{
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "lint": "biome check .",
    "lint:fix": "biome check --fix .",
    "format": "biome format --write .",
    "typecheck": "tsc --noEmit"
  }
}
```

### GitHub Actions CI

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test
```
