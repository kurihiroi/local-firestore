# Firestore Security Rules 100%カバレッジ実装計画

## 現状の問題

現在の `rules-engine.ts` は正規表現ベースのパターンマッチで式を評価しており、
ハードコードされた数パターンしか対応できない。Firestore ルール言語の全機能をサポートするには、
**適切なレキサー・パーサー・評価器（AST ベース）** への作り直しが必要。

## アーキテクチャ

```
security/
├── rules-engine.ts          # エントリポイント（SecurityRulesEngine クラス）※改修
├── rules-middleware.ts       # HTTP ミドルウェア ※小改修（request.resource/request.time 対応）
├── rules-parser/
│   ├── lexer.ts              # トークナイザー
│   ├── parser.ts             # AST パーサー
│   └── ast.ts                # AST ノード型定義
├── rules-evaluator/
│   ├── evaluator.ts          # AST 評価器（メイン）
│   ├── types.ts              # ランタイム値型（RulesValue）
│   ├── context.ts            # 評価コンテキスト（request, resource, math 等）
│   ├── operators.ts          # 演算子の実装
│   ├── builtin-functions.ts  # get(), exists(), getAfter(), debug()
│   ├── string-methods.ts     # String メソッド群
│   ├── list-methods.ts       # List メソッド群
│   ├── map-methods.ts        # Map / MapDiff メソッド群
│   ├── set-methods.ts        # Set メソッド群
│   ├── timestamp-methods.ts  # Timestamp メソッド群・namespace関数
│   ├── duration-methods.ts   # Duration メソッド群・namespace関数
│   ├── latlng-methods.ts     # LatLng メソッド群・namespace関数
│   ├── bytes-methods.ts      # Bytes メソッド群
│   ├── math-functions.ts     # math namespace 関数
│   └── hashing-functions.ts  # hashing namespace 関数
└── __tests__/
    ├── lexer.test.ts
    ├── parser.test.ts
    ├── evaluator.test.ts
    ├── operators.test.ts
    ├── string-methods.test.ts
    ├── list-methods.test.ts
    ├── map-methods.test.ts
    ├── set-methods.test.ts
    ├── timestamp-methods.test.ts
    ├── duration-methods.test.ts
    ├── latlng-methods.test.ts
    ├── bytes-methods.test.ts
    ├── math-functions.test.ts
    ├── hashing-functions.test.ts
    └── builtin-functions.test.ts
```

## 実装ステップ

### Step 1: AST ノード型定義 (`ast.ts`)

全ての式構造を表現する AST ノード型を定義する。

- リテラル: `BoolLiteral`, `IntLiteral`, `FloatLiteral`, `StringLiteral`, `NullLiteral`
- 識別子: `Identifier` (変数参照)
- メンバーアクセス: `MemberExpression` (`a.b`, `a.b.c`)
- インデックスアクセス: `IndexExpression` (`list[0]`, `map["key"]`)
- 関数呼び出し: `CallExpression` (`size()`, `get(path)`)
- メソッド呼び出し: `MethodCallExpression` (`str.matches(regex)`)
- 二項演算: `BinaryExpression` (`+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `in`)
- 単項演算: `UnaryExpression` (`!`, `-`)
- 三項演算: `ConditionalExpression` (`a ? b : c`)
- 型チェック: `IsExpression` (`value is string`)
- リストリテラル: `ListExpression` (`[1, 2, 3]`)
- マップリテラル: `MapExpression` (`{"key": value}`)
- let 束縛: `LetBinding` (`let x = expr;`)
- return 文: `ReturnStatement`
- 関数定義: `FunctionDeclaration`

### Step 2: レキサー (`lexer.ts`)

ルール式文字列をトークン列に変換する。

**トークン種別:**
- 数値リテラル (int/float)
- 文字列リテラル (`'...'`, `"..."`)
- 識別子・キーワード (`true`, `false`, `null`, `let`, `return`, `function`, `is`, `in`)
- 演算子 (`+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`)
- 区切り子 (`.`, `,`, `(`, `)`, `[`, `]`, `{`, `}`, `:`, `;`, `?`)

### Step 3: パーサー (`parser.ts`)

トークン列を AST に変換する再帰下降パーサー。

**演算子の優先順位（低→高）:**
1. `? :` (三項)
2. `||` (論理OR)
3. `&&` (論理AND)
4. `==`, `!=` (等値)
5. `<`, `<=`, `>`, `>=`, `in`, `is` (比較・型チェック)
6. `+`, `-` (加減算)
7. `*`, `/`, `%` (乗除算)
8. `!`, `-` (単項)
9. `.`, `()`, `[]` (メンバー・呼び出し・添字)

### Step 4: ランタイム値型 (`types.ts`)

評価器が扱うランタイム値の型体系を定義する。

```typescript
type RulesValue =
  | RulesBool
  | RulesInt
  | RulesFloat
  | RulesString
  | RulesBytes
  | RulesNull
  | RulesList
  | RulesMap
  | RulesSet
  | RulesTimestamp
  | RulesDuration
  | RulesLatLng
  | RulesPath
  | RulesMapDiff
```

各型に `typeName` フィールドを持たせ、`is` 演算子で型チェックできるようにする。

### Step 5: 評価コンテキスト (`context.ts`)

`request`, `resource`, `math`, `timestamp`, `duration`, `latlng`, `hashing` などの
グローバルオブジェクト・名前空間をコンテキストとして構築する。

- `request.auth` → AuthContext（uid + token claims）
- `request.resource.data` → 書き込みデータ
- `request.time` → リクエスト時刻（Timestamp型）
- `request.path` → リクエストパス（Path型）
- `request.method` → 操作種別
- `request.query` → クエリパラメータ
- `resource.data` → 既存ドキュメントデータ
- `resource.id` → ドキュメントID
- `resource.__name__` → フルパス

### Step 6: 演算子の実装 (`operators.ts`)

- 算術: `+`（数値加算・文字列結合・リスト結合）, `-`, `*`, `/`, `%`
- 比較: `==`, `!=`, `<`, `<=`, `>`, `>=`（型を考慮した比較）
- 論理: `&&`（短絡）, `||`（短絡）, `!`
- メンバーシップ: `in`（リスト・マップ・セット）
- 型チェック: `is`
- 三項: `? :`

### Step 7: 評価器メイン (`evaluator.ts`)

AST ノードを再帰的にウォークして値を返す。

- リテラル → 対応する RulesValue
- 識別子 → コンテキストから解決
- メンバーアクセス → オブジェクトのプロパティ解決
- 関数呼び出し → 組み込み関数 or カスタム関数を呼び出し
- メソッド呼び出し → 型に応じたメソッドディスパッチ
- 二項/単項/三項演算 → operators.ts に委譲
- let 束縛 → スコープに変数追加
- カスタム関数 → 関数テーブルに登録・呼び出し

### Step 8: 組み込み関数 (`builtin-functions.ts`)

- `get(path)` → DocumentService を通じてドキュメント取得（RulesMap を返す）
- `exists(path)` → ドキュメント存在チェック（bool）
- `getAfter(path)` → トランザクション内の書き込み後状態取得
- `debug(value)` → コンソール出力して値をそのまま返す

`get()`/`exists()` はルール評価中にDBアクセスが必要なため、
`SecurityRulesEngine` に `DocumentService` への参照を持たせる。

### Step 9: 型別メソッド群

各ファイルで型固有のメソッドを実装する。

**string-methods.ts:**
`size()`, `matches()`, `split()`, `trim()`, `lower()`, `upper()`,
`replace()`, `contains()`, `startsWith()`, `endsWith()`, `toUtf8()`

**list-methods.ts:**
`size()`, `hasAny()`, `hasAll()`, `hasOnly()`, `toSet()`, `join()`, `concat()`

**map-methods.ts:**
`size()`, `keys()`, `values()`, `get()`, `diff()`
+ MapDiff: `addedKeys()`, `removedKeys()`, `changedKeys()`, `unchangedKeys()`, `affectedKeys()`

**set-methods.ts:**
`size()`, `hasAny()`, `hasAll()`, `hasOnly()`, `union()`, `intersection()`, `difference()`

**timestamp-methods.ts:**
`date()`, `year()`, `month()`, `day()`, `hours()`, `minutes()`, `seconds()`,
`nanos()`, `dayOfWeek()`, `dayOfYear()`, `toMillis()`
+ namespace: `timestamp.date()`, `timestamp.value()`

**duration-methods.ts:**
`seconds()`, `minutes()`, `hours()`, `nanos()`
+ namespace: `duration.time()`, `duration.value()`

**latlng-methods.ts:**
`latitude()`, `longitude()`, `distance()`
+ namespace: `latlng.value()`

**bytes-methods.ts:**
`size()`, `toBase64()`, `toHexString()`

### Step 10: 名前空間関数

**math-functions.ts:**
`math.abs()`, `math.ceil()`, `math.floor()`, `math.round()`,
`math.sqrt()`, `math.pow()`, `math.isNaN()`, `math.isInfinite()`

**hashing-functions.ts:**
`hashing.md5()`, `hashing.sha256()`, `hashing.crc32()`, `hashing.crc32c()`

### Step 11: カスタム関数サポート

- `function` キーワードで定義された関数をパースし `FunctionDeclaration` ノードに変換
- 評価時に関数テーブルに登録
- 呼び出し時に引数をバインドして `return` 文の式を評価
- `let` 束縛のサポート（最大10個）
- 再帰禁止、コールスタック深度制限（20）

### Step 12: ルール定義形式の拡張

現在の JSON ベースのルール定義を維持しつつ、式の部分で全機能が使えるようにする。
ルール定義インターフェースは基本的に変更不要（`string` 式部分がフルパーサーで評価されるようになる）。

追加で対応する項目:
- `CollectionRule` に `functions` フィールドを追加（カスタム関数定義用）
- ワイルドカード変数名の自由化（`{userId}` 等、`{collection}` 以外も対応）
- 再帰ワイルドカード `{document=**}` のサポート
- ワイルドカード変数を式内で参照可能にする

### Step 13: SecurityRulesEngine の改修

- コンストラクタに `DocumentService`（オプション）を受け取れるようにする
- `evaluate()` 内で旧正規表現ベースの `evaluateExpression()` を新 AST ベース評価器に置き換え
- `RuleContext` を拡張して `request.time`, `request.query` 等を追加
- ワイルドカード変数のバインディングを実装

### Step 14: rules-middleware の改修

- `request.resource.data`（リクエストボディ）を context に設定
- `request.time` を現在時刻の Timestamp として設定
- `request.query` パラメータの取得と設定
- `resource.data` の設定（update/delete 時に既存データを取得）
- カスタムクレーム対応の認証（`auth.token.*`）

### Step 15: テスト

各モジュールに対して網羅的なユニットテストを作成する。
既存の `rules-engine.test.ts` と `rules-middleware.test.ts` のテストケースは
すべてパスし続けるようにする（後方互換性の担保）。

## 実装優先順位

1. **基盤**: ast.ts → lexer.ts → parser.ts → types.ts （これがないと何も動かない）
2. **コア評価**: evaluator.ts → context.ts → operators.ts （最小限の式評価）
3. **基本メソッド**: string-methods → list-methods → map-methods （最頻出）
4. **組み込み関数**: builtin-functions.ts （get/exists）
5. **追加型**: set-methods → timestamp → duration → latlng → bytes
6. **名前空間**: math → hashing
7. **高度な機能**: カスタム関数、let 束縛、再帰ワイルドカード
8. **統合**: SecurityRulesEngine 改修 → middleware 改修
9. **テスト**: 各ステップと並行して作成

## 注意事項

- `any` 型は使用禁止（CLAUDE.md の制約）
- 外部パーサーライブラリは使わず、自前で実装（依存を最小化）
- 既存テストの後方互換性を維持
- `get()`/`exists()` は呼び出し回数制限を実装（Firestore の制約: 1ルール評価あたり最大10回）
