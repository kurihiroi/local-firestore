# Firestore DSL パーサー + Admin UI ルール設定機能

## 概要

Firestore互換のセキュリティルールDSL（`service cloud.firestore { match ... { allow read: if ...; } }`）をパースし、内部の `SecurityRules` JSON形式に変換する。Admin UIにルール設定画面を追加し、ブラウザからDSLを編集・適用できるようにする。

## 前提

- 既存の式パーサー（`rules-parser/`）は個別のルール式（`request.auth != null` など）をパース可能
- `SecurityRulesEngine` は JSON形式の `SecurityRules` を受け取って評価可能
- **不足**: Firestore DSL全体のパース（`service`, `match`, `allow` 構文）、ルールの永続化、Admin UI

## Step 1: Firestore DSL パーサーの実装

**新規ファイル**: `packages/server/src/security/firestore-rules-parser.ts`

対応する構文:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isOwner(userId) {
      return request.auth.uid == userId;
    }

    match /users/{userId} {
      allow read: if true;
      allow write: if request.auth.uid == userId;
    }

    match /posts/{postId} {
      allow read: if true;
      allow create: if request.auth != null;
      allow update, delete: if request.auth.uid == resource.data.authorId;

      match /comments/{commentId} {
        allow read: if true;
        allow write: if request.auth != null;
      }
    }
  }
}
```

**変換結果** (`SecurityRules` 形式):
```json
{
  "functions": "function isOwner(userId) { return request.auth.uid == userId; }",
  "rules": {
    "users/{userId}": {
      "read": true,
      "write": "request.auth.uid == userId"
    },
    "posts/{postId}": {
      "read": true,
      "create": "request.auth != null",
      "update": "request.auth.uid == resource.data.authorId",
      "delete": "request.auth.uid == resource.data.authorId",
      "subcollections": {
        "comments/{commentId}": {
          "read": true,
          "write": "request.auth != null"
        }
      }
    }
  }
}
```

**実装方針**:
- DSL全体用の新規パーサーを作成（既存の式パーサーは再利用しない）
- 構造部分（`service`, `match`, `allow`, `if`）を解析、`if` 以降の式は文字列として抽出
- `function` 宣言も文字列として抽出し、該当スコープの `functions` フィールドに格納
- `allow read, write: if expr;` の複数操作対応
- `true`/`false` リテラルはboolean値に変換

**テスト**: `packages/server/src/security/__tests__/firestore-rules-parser.test.ts`

## Step 2: ルール永続化（SQLiteテーブル）

**新規ファイル**: `packages/server/src/storage/rules-repository.ts`

```sql
CREATE TABLE IF NOT EXISTS security_rules (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rules_text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- `getRules(): string | null` - 保存されたDSLテキストを取得
- `saveRules(rulesText: string): void` - DSLテキストをUPSERT

## Step 3: ルール管理APIエンドポイント

**変更ファイル**: `packages/server/src/routes/admin-ui.ts`

- `GET /admin/api/rules` - 現在のルールDSLテキストを返す
- `PUT /admin/api/rules` - DSLテキストを受け取り→パース→バリデーション→保存→エンジンホットリロード
  - パースエラー時は400（エラーメッセージ付き）
  - 成功時は `SecurityRulesEngine` をその場で差し替え

## Step 4: Admin UIにSecurity Rulesタブを追加

**変更ファイル**: `packages/server/src/routes/admin-ui.ts` のHTML部分

- ヘッダーにナビゲーション: 「Documents」「Security Rules」
- Security Rulesタブ:
  - コードエディタ風テキストエリアにDSL表示・編集
  - 「Save」ボタン → PUT /admin/api/rules
  - バリデーションエラーのインライン表示
  - 未設定時はデフォルトテンプレート表示
  - 保存成功時のトースト通知

## Step 5: createApp / CLI でのルール統合

**変更ファイル**:
- `packages/server/src/app.ts` - `AppOptions` を拡張、Admin UIに永続化層を渡す
- `packages/server/src/cli.ts` - 起動時にSQLiteからルール読み込み

**内容**:
- `createApp` が `RulesRepository` を受け取れるようにし Admin UI ルートに渡す
- `SecurityRulesEngine` の動的差し替え対応（Admin UIからの変更をサーバー再起動なしで反映）
- CLI起動時: DBからルール読み込み → パース → エンジン作成 → AppOptionsに渡す
- ルール未設定時はオープンルール（開発用デフォルト）
- 環境変数 `FIRESTORE_RULES_PATH` でファイルからの初期読み込みもサポート

## Step 6: export追加 + lint + テスト + ビルド

- `packages/server/src/index.ts` に新規export追加
- `pnpm lint` / `pnpm test` / `pnpm build` 全パス

## ファイル一覧

| ファイル | 種別 |
|---|---|
| `packages/server/src/security/firestore-rules-parser.ts` | 新規 |
| `packages/server/src/security/__tests__/firestore-rules-parser.test.ts` | 新規 |
| `packages/server/src/storage/rules-repository.ts` | 新規 |
| `packages/server/src/routes/admin-ui.ts` | 変更 |
| `packages/server/src/app.ts` | 変更 |
| `packages/server/src/cli.ts` | 変更 |
| `packages/server/src/index.ts` | 変更 |

## 設計判断

1. **式パーサーはそのまま**: DSLパーサーは `if` 以降の式を文字列抽出して `SecurityRulesEngine` に渡す（既存フロー維持）
2. **シングルトンテーブル**: Firestore本家と同じくルールは1つだけ。IDを1に固定
3. **ホットリロード**: Admin UIからの変更をサーバー再起動なしで反映
4. **`any` 型禁止**: CLAUDE.md ルールに従う
