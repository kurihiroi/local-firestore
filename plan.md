# 未実装機能の実装計画

docs/2026-03-22-firestore-feature-differences.md の未実装項目を優先度・依存関係に基づいて整理した実装計画。

---

## Phase 1: クライアント SDK の API 互換性向上（影響度: 高、難易度: 低〜中）

本家 Firebase SDK との互換性を高め、移行時の摩擦を減らす項目。既存コードの拡張で完結し、破壊的変更が少ない。

### 1-1. `DocumentSnapshot.get(fieldPath)` の実装
- **対象ファイル**: `packages/client/src/types.ts`
- **内容**: `get(fieldPath: string | FieldPath)` メソッドを `DocumentSnapshot` に追加。ドット記法のネストフィールドアクセスに対応
- **テスト**: `packages/client/src/types.test.ts` に追加

### 1-2. `QueryDocumentSnapshot` に `ref` プロパティを追加
- **対象ファイル**: `packages/client/src/snapshots.ts`
- **内容**: 現在 `path` と `id` のみ。`DocumentReference` を返す `ref` プロパティを追加
- **依存**: `createDocumentReference` (references.ts) を使って生成。Firestore インスタンスへの参照が必要なため、コンストラクタ引数の拡張が必要
- **テスト**: `packages/client/src/snapshots.test.ts` (新規作成 or 既存テストに追加)

### 1-3. `QueryDocumentSnapshot.get(fieldPath)` の実装
- **対象ファイル**: `packages/client/src/snapshots.ts`
- **内容**: 1-1 と同様のロジック
- **テスト**: 1-2 と同じファイル

### 1-4. `QuerySnapshot.query` プロパティの実装
- **対象ファイル**: `packages/client/src/snapshots.ts`
- **内容**: `QuerySnapshot` に元のクエリへの参照を保持する `query` プロパティを追加。コンストラクタ引数にクエリを追加
- **影響範囲**: `getDocs()` (crud.ts)、`onSnapshot()` (listener.ts) で QuerySnapshot 生成箇所を修正
- **テスト**: 既存テストの更新 + 新規テスト

### 1-5. `Timestamp.toJSON()` / `Timestamp.toString()` の実装
- **対象ファイル**: `packages/client/src/types.ts`
- **内容**:
  - `toJSON()`: `{ seconds, nanoseconds }` を返す
  - `toString()`: 人間可読な文字列表現を返す
- **テスト**: `packages/client/src/types.test.ts`

### 1-6. `updateDoc` のフィールドパス形式対応
- **対象ファイル**: `packages/client/src/crud.ts`
- **内容**: `updateDoc(ref, field, value, ...moreFieldsAndValues)` のオーバーロードを追加。フィールドパス（ドット記法文字列 or FieldPath）と値のペアをオブジェクトに変換
- **テスト**: `packages/e2e/src/crud.test.ts` or `crud-extended.test.ts`

### 1-7. `onSnapshot` の Observer オブジェクト形式対応
- **対象ファイル**: `packages/client/src/listener.ts`
- **内容**: `onSnapshot(ref, { next, error, complete })` 形式のオーバーロードを追加
- **テスト**: `packages/e2e/src/listeners.test.ts`

### 1-8. `documentId()` 関数の実装
- **対象ファイル**: `packages/client/src/query.ts` + `packages/server/src/services/query.ts`
- **内容**: `where(documentId(), '==', 'docId')` のような使い方を可能にする特殊フィールドセンチネルを実装。サーバー側でもドキュメント ID でのフィルタリングに対応
- **テスト**: `packages/e2e/src/query.test.ts`

---

## Phase 2: メタデータ・型の互換性（影響度: 中、難易度: 中）

### 2-1. `SnapshotMetadata` の実装
- **対象ファイル**: `packages/client/src/types.ts` (新しいクラス)
- **内容**: `hasPendingWrites: boolean`, `fromCache: boolean`, `isEqual()` を持つクラス。ローカルエミュレータなので `hasPendingWrites: false`, `fromCache: false` を基本とする
- **影響範囲**: `DocumentSnapshot.metadata`, `QuerySnapshot.metadata` に追加

### 2-2. `SnapshotOptions` 型の実装
- **対象ファイル**: `packages/client/src/types.ts`
- **内容**: `{ serverTimestamps?: 'estimate' | 'previous' | 'none' }` 型を定義。`data(options?)` の引数として受け取るが、ローカルではサーバータイムスタンプは常に解決済みなので実質 no-op
- **テスト**: 型互換性の確認

### 2-3. 等値比較関数群の実装
- **対象ファイル**: `packages/client/src/index.ts` + 各ファイル
- **内容**: `refEqual()`, `queryEqual()`, `snapshotEqual()` を実装
- **テスト**: ユニットテスト

### 2-4. `DocumentReference.firestore` / `converter` の公開プロパティ化
- **対象ファイル**: `packages/client/src/types.ts`, `packages/client/src/references.ts`
- **内容**: `_firestore` → `firestore` (getter)、`_converter` → `converter` (getter) を追加。後方互換のため `_firestore`, `_converter` も維持
- **破壊的変更リスク**: 低（getter 追加のみ）

### 2-5. クエリ制約の型定義
- **対象ファイル**: `packages/client/src/query.ts`
- **内容**: `QueryConstraintType`, `QueryFilterConstraint`, `QueryNonFilterConstraint` の型/ユニオン型を定義し export
- **テスト**: 型レベルのテスト

---

## Phase 3: ユーティリティ関数（影響度: 低〜中、難易度: 低）

### 3-1. `terminate()` の実装
- **対象ファイル**: `packages/client/src/firestore.ts`
- **内容**: WebSocket 接続のクローズ、pending な操作の中断。ConnectionManager の `disconnect()` を呼ぶ
- **テスト**: ユニットテスト

### 3-2. `enableNetwork()` / `disableNetwork()` の実装
- **対象ファイル**: `packages/client/src/firestore.ts`
- **内容**: ネットワーク無効化時は WriteQueue にエンキューし、有効化時にフラッシュする。ConnectionManager との連携
- **テスト**: ユニットテスト + E2E

### 3-3. `waitForPendingWrites()` の実装
- **対象ファイル**: `packages/client/src/firestore.ts`
- **内容**: WriteQueue の pending 書き込みがすべて完了するまで待機する Promise を返す
- **テスト**: ユニットテスト

### 3-4. `setLogLevel()` の実装
- **対象ファイル**: `packages/client/src/firestore.ts`
- **内容**: クライアント側のログレベル制御。`'debug' | 'error' | 'silent'` 程度
- **テスト**: ユニットテスト

---

## Phase 4: Tree Shaking 対応（影響度: 中、難易度: 低）

### 4-1. `sideEffects: false` の追加
- **対象ファイル**: 各パッケージの `package.json`（shared, client, server）
- **内容**: `"sideEffects": false` を追加

### 4-2. tsup splitting の有効化（検討）
- **対象ファイル**: 各パッケージの `tsup.config.ts`
- **内容**: `splitting: true` への変更を検討。ESM ビルドではチャンク分割が有効になる
- **注意**: CJS ビルドでは splitting は使用不可。動作確認が必要

---

## Phase 5: アプリケーション機能（影響度: 高、難易度: 高）

### 5-1. Cloud Functions トリガーのエミュレーション
- **対象ファイル**: `packages/server/src/services/` (新ファイル), `packages/server/src/routes/` (新ファイル)
- **設計**:
  - `TriggerService` クラスを新設。`onCreate`, `onUpdate`, `onDelete`, `onWrite` のトリガーを登録可能
  - ドキュメント変更時に DocumentService から TriggerService に通知し、登録済みハンドラを実行
  - トリガーの登録は HTTP API (`POST /triggers`) で行う。ユーザーは別プロセスで Cloud Functions のコードを起動し、コールバック URL を登録する形式
  - 代替案: サーバーに直接関数を登録できる Node.js API を提供
- **テスト**: ユニットテスト + E2E
- **検討事項**: Cloud Functions emulator との連携方式を決める必要あり

### 5-2. 複合インデックス定義のバリデーション
- **対象ファイル**: `packages/server/src/services/` (新ファイル)
- **設計**:
  - `IndexManager` クラスを新設。`firestore.indexes.json` をパースしてインデックス定義を管理
  - クエリ実行時に必要なインデックスが定義されているか検証し、未定義の場合は警告またはエラーを返す
  - 実際のクエリ実行は従来通り SQLite に委譲（インデックスのバリデーションのみ）
  - `strict` モード: 本家同様にエラーを返す / `warn` モード: 警告ログのみ
- **テスト**: ユニットテスト

### 5-3. TTL (Time-to-Live) の実装
- **対象ファイル**: `packages/server/src/services/` (新ファイル)
- **設計**:
  - `TtlService` クラスを新設。TTL ポリシー（対象コレクション + Timestamp フィールド）を定義
  - 定期的（設定可能なインターバル）に期限切れドキュメントを検出し削除
  - 削除時は DocumentService 経由で行い、リスナー通知やトリガーも発火させる
- **テスト**: ユニットテスト + E2E

---

## Phase 6: 先進的機能（影響度: 中〜低、難易度: 高）

### 6-1. マルチデータベースの実装
- **設計**:
  - サーバー起動時に複数のデータベースインスタンスを作成可能にする
  - 各データベースが独立した SQLite ファイルを持つ
  - ルーティングに database ID を含める (`/databases/:dbId/docs/:path`)
  - クライアント SDK で `getFirestore(app, databaseId)` の形式をサポート
- **影響範囲**: サーバー全体のアーキテクチャに影響。大規模な変更

### 6-2. ベクトル検索（VectorValue + FindNearest）
- **設計**:
  - `VectorValue` クラスをクライアント SDK に追加
  - サーバー側で `FindNearest` クエリを SQLite で実装（コサイン類似度 / ユークリッド距離）
  - SQLite の数値配列として保存し、距離計算は SQL のユーザー定義関数で実装
- **影響範囲**: 型定義、シリアライズ、クエリエンジン

---

## 実装順序のまとめ

| 優先度 | Phase | 推定工数 | 理由 |
|--------|-------|----------|------|
| 1 | Phase 1 (SDK 互換性) | 中 | 移行時の摩擦が最も大きい部分。個々の変更は小さい |
| 2 | Phase 4 (Tree Shaking) | 小 | 設定変更のみで効果が大きい |
| 3 | Phase 2 (メタデータ・型) | 中 | API 互換性の仕上げ |
| 4 | Phase 3 (ユーティリティ) | 小 | あると便利だが必須ではない |
| 5 | Phase 5 (アプリ機能) | 大 | 設計判断が必要。個別に検討 |
| 6 | Phase 6 (先進的機能) | 大 | ニーズに応じて |

---

## スコープ外（実装しない項目）

以下はクラウドインフラ依存または本家でも非推奨/プレビューのため、実装対象外とする:

- クラウドインフラ依存機能（マルチリージョン、IAM、監査ログ、PITR、BigQuery 連携等）
- IndexedDB 関連 API（`clearIndexedDbPersistence`, `enableIndexedDbPersistence` 等）— ブラウザ専用機能
- データバンドル（`loadBundle`, `namedQuery`）— 低優先度
- パイプラインクエリ — 本家でもプレビュー段階
- キャッシュ管理 API（`persistentLocalCache`, `memoryLocalCache` 等）— ブラウザ専用
- SSR/CSR 向け API（`documentSnapshotFromJSON`, `querySnapshotFromJSON`, `onSnapshotResume`）— 特殊用途
- `FieldValue` ベースクラス — 現在の `FieldValueSentinel` アプローチで十分
- 個別の QueryConstraint サブクラス群 — 現在の `QueryConstraint` インターフェースで統一済み
