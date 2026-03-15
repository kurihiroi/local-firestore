# Local Firestore クローン 要件定義

動作確認およびLAN内での機密データ取り扱いを目的とした、Firestoreクローンの要件一覧。

---

## 機能要件

### データモデル

- コレクション / ドキュメント / サブコレクションの階層構造
- ドキュメントIDの自動生成・手動指定
- Firestoreのデータ型サポート（string, number, boolean, map, array, timestamp, geopoint, reference, null, bytes）
- ネストされたmap/arrayの再帰的な格納

### CRUD操作

- ドキュメントの作成（`add` / `set`）
- ドキュメントの読み取り（`get`）
- ドキュメントの更新（`update` / `set with merge`）
- ドキュメントの削除（`delete`）
- フィールドの削除（`FieldValue.delete()`）
- `FieldValue.serverTimestamp()` / `increment()` / `arrayUnion()` / `arrayRemove()`

### クエリ

- 等価フィルタ（`==`, `!=`）
- 比較フィルタ（`<`, `<=`, `>`, `>=`）
- 配列フィルタ（`array-contains`, `array-contains-any`）
- `in` / `not-in` クエリ
- 複合クエリ（複数条件の `where`）
- `orderBy`（昇順・降順）
- `limit` / `limitToLast`
- `startAt` / `startAfter` / `endAt` / `endBefore`（カーソルページネーション）
- コレクショングループクエリ

### リアルタイムリスナー

- ドキュメント単位の `onSnapshot`
- クエリ単位の `onSnapshot`
- 変更タイプの通知（`added` / `modified` / `removed`）
- リスナーの解除

### バッチ・トランザクション

- バッチ書き込み（`writeBatch`）
- トランザクション（楽観的同時実行制御）
- トランザクション内での読み取り→書き込みの整合性保証

### インデックス

- 単一フィールドインデックス（自動）
- 複合インデックスの定義・利用
- インデックス不足時のエラー通知

### セキュリティルール

- Firestore Security Rules の評価エンジン
- `request` / `resource` オブジェクトの再現
- カスタム関数の定義
- ルールのホットリロード

### API互換性

- Firebase Admin SDK互換のREST API / gRPC API
- クライアントSDK（Web, iOS, Android）からの接続互換
- Firebase Emulatorと同等 or 互換のエンドポイント

---

## 非機能要件

### パフォーマンス

- 低レイテンシ（LAN内での応答速度）
- 大量ドキュメントの効率的なクエリ実行
- リアルタイムリスナーのスケーラビリティ（同時接続数）

### データ永続性

- ディスクへのデータ永続化（再起動後もデータ保持）
- オプショナルなインメモリモード（高速テスト用）

### セキュリティ

- LAN内通信のTLS対応
- 認証・認可の仕組み（Firebase Auth相当 or 簡易トークン認証）
- 機密データの暗号化at-rest

### 運用性

- シンプルなセットアップ（ワンコマンド起動）
- 設定ファイルによる柔軟な構成
- ログ出力（リクエスト/レスポンス、エラー）
- データのエクスポート / インポート（本番Firestoreとの同期用）
- Web UIによるデータ閲覧・編集（Firebase Console相当）

### 互換性・移植性

- Docker対応（コンテナでの実行）
- クロスプラットフォーム（Linux / macOS / Windows）
- Firebase Emulatorからのデータ移行対応

### テスタビリティ

- データの初期化・リセット機能
- スナップショット/リストア機能
- テストごとのデータ分離

### 可観測性

- メトリクス公開（接続数、クエリ数、レイテンシ等）
- ヘルスチェックエンドポイント
