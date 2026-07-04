# 残課題

docs/2026-03-22-firestore-feature-differences.md の Phase 1〜6（旧計画）は実装完了済み。
2026-07-04 の Firestore 互換性修正で以下も完了した:

- 特殊型（Timestamp / GeoPoint / Bytes / VectorValue / DocumentReference / Date）の
  シリアライズ統一と読み取り時のインスタンス復元（round-trip）
- クエリ比較セマンティクスの Firestore 互換化（`firestore_key` ソートキー UDF）:
  型順序、範囲フィルタの型ブラケット、`!=` / `not-in` の null・欠損除外、
  orderBy の欠損フィールド除外、`__name__` 暗黙タイブレーク、不等式フィルタの暗黙ソート、
  複数 orderBy カーソルの辞書式タプル比較、`array-contains(-any)` の Firestore 等値
- `limitToLast` の orderBy 必須バリデーション、limit 重複指定時の「最後が有効」化
- `updateDoc` ドット記法のリーフ更新（兄弟フィールド保持）、`setDoc merge` の深いマージ
- ネストしたマップ内・ドット記法パスの FieldValue センチネル解決、
  `arrayUnion` / `arrayRemove` の深い等値比較
- クライアント認証トークン送信（`FirestoreSettings.authTokenProvider`）+
  サーバー側 Firebase Auth ID トークン検証（`AUTH_PROVIDER=firebase`）の E2E 接続

2026-07-04 の Firestore 入れ替え互換性向上で以下も完了した:

- **セキュリティルールの適用範囲拡大**: `/query` / `/aggregate`（`list` として評価）、
  `/batch` / `/transaction/commit`（各オペレーションを `create` / `update` / `delete` として評価。
  `set` は既存ドキュメントの有無で create / update を判定）、`/transaction/get`（`get` として評価）、
  WebSocket リスナー（subscribe メッセージの `authToken` フィールドで認証。
  `subscribe_doc` → `get`、`subscribe_query` → `list` を評価し、拒否時は
  `permission-denied` エラーメッセージを返す）。クライアントはサブスクライブメッセージを
  ファクトリ化し、再接続時にも最新トークンを送信する。
  CLI サーバーは `RULES_PATH` 環境変数でルール JSON を読み込む
- **FirebaseApp 連携によるトークン自動取得**: `getFirestore(app)` に本物の `FirebaseApp` が
  渡された場合、`firebase/auth`（optional peer dependency）の `getIdToken()` を自動的に
  `authTokenProvider` として配線。FirebaseApp ごと・databaseId ごとにインスタンスをキャッシュ
  （本家と同じく同一インスタンスを返す）
- **`connectFirestoreEmulator()`**: 本家互換シム。接続先ホスト/ポートの差し替えと
  `mockUserToken`（文字列 / オブジェクト）に対応。使用開始後の呼び出しは本家同様エラー
- **スナップショットカーソル**: `startAt` / `startAfter` / `endAt` / `endBefore` に
  `DocumentSnapshot` / `QueryDocumentSnapshot` を渡せる。orderBy フィールドの値 +
  `__name__`（ドキュメントパス）タイブレークへ展開され、同値ドキュメントも正しくスキップされる

以下は未実装の残課題を優先度順に整理したもの。

---

## 高優先度

### 1. ルール評価エンジンの特殊型対応
- **現状**: `resource.data` / `request.resource.data` 内の `{__type: "timestamp", ...}` ラッパーが
  ただのマップとして評価される。ルール内の timestamp メソッド・比較が本家と一致しない
- **内容**: 評価エンジンで `__type` ラッパーを対応するルール型（timestamp / bytes / latlng / path）に
  変換してから評価する
- **対象**: `packages/server/src/security/rules-evaluator/`
- **備考**: ルールの適用範囲がクエリ / バッチ / リスナーへ拡大されたため、この差異の影響範囲も
  以前より広い。次に着手すべき項目

---

## 中優先度

### 2. クエリバリデーションの本家パリティ
- `in` / `not-in` / `array-contains-any` の最大30要素制限
- `array-contains` の複数指定、`not-in` と `!=` の併用等、本家がエラーにする組合せの検出
- 対象: `packages/client/src/query.ts`（クライアント側で早期エラー）+ サーバー側検証

### 3. 数値型の忠実度
- 本家は int64 / double を区別する（JS SDK 上は透過的だが、`2^53` 超の整数で精度が変わる）
- NaN の順序（本家: NaN は数値の最小として扱われ、`== NaN` フィルタも可能）
- 対象: `packages/server/src/storage/firestore-key.ts`, シリアライズ層

### 4. Timestamp のマイクロ秒切り捨て
- 本家はマイクロ秒精度に切り捨てる。現在はナノ秒をそのまま保持
- `Timestamp.fromISO()` がミリ秒精度で丸めるため、`createTime` / `updateTime` の精度も本家と異なる

### 5. sum / avg の非数値スキップ
- 本家の `sum()` / `avg()` は数値フィールドのみを集計対象にする。
  現在は SQLite の `SUM` / `AVG` の型強制に依存（文字列が 0 扱いになる等）
- 対象: `packages/server/src/services/query.ts`（`firestore_key` の型タグで数値のみに絞る）

### 6. 書き込みバリデーション
- 配列内の FieldValue センチネル（本家はエラー）、`undefined` 値（本家はデフォルトでエラー、
  `ignoreUndefinedProperties` オプションあり）の検証
- `deleteField()` の内部表現 `"$$__DELETE__$$"` が同じ文字列値の書き込みと衝突しうる。
  センチネルをプロトコルレベルの表現に変更する

### 7. 旧形式データのマイグレーション
- 2026-07-04 以前に保存されたデータでは、クライアント書き込みの Timestamp が素の
  `{seconds, nanoseconds}` マップになっている。検出して `{__type: "timestamp"}` 形式に
  変換するマイグレーションスクリプト（または export → import での変換）を提供する

---

## 低優先度

- `getDocFromCache()` / `getDocsFromCache()` の配線（`SnapshotCache` は存在するが読み取り API 未接続）
- コレクショングループクエリの順序（本家は完全なリソース名順。親パスが異なる場合の順序検証）
- `aggregateFieldEqual()` / `aggregateQuerySnapshotEqual()`

## スコープ外（実装しない項目）

以下はクラウドインフラ依存または本家でも非推奨/プレビューのため、実装対象外とする:

- クラウドインフラ依存機能（マルチリージョン、IAM、監査ログ、PITR、BigQuery 連携等）
- IndexedDB 関連 API（`clearIndexedDbPersistence`, `enableIndexedDbPersistence` 等）— ブラウザ専用機能
- データバンドル（`loadBundle`, `namedQuery`）、パイプラインクエリ — 本家でもプレビュー/低需要
- キャッシュ管理 API（`persistentLocalCache`, `memoryLocalCache` 等）— ブラウザ専用
- SSR/CSR 向け API（`documentSnapshotFromJSON`, `querySnapshotFromJSON`, `onSnapshotResume`）— 特殊用途
- `FieldValue` ベースクラス — 現在の `FieldValueSentinel` アプローチで十分
- 個別の QueryConstraint サブクラス群 — 現在の `QueryConstraint` インターフェースで統一済み
