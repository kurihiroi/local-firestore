# Google Cloud Firestore との機能差分

本ドキュメントでは、local-firestore と Google Cloud Firestore の機能差分を整理する。

---

## 実装済み機能

| カテゴリ | 機能 | 備考 |
|---------|------|------|
| CRUD | `getDoc`, `setDoc`, `updateDoc`, `deleteDoc`, `addDoc` | |
| CRUD | `setDoc` の `merge` / `mergeFields` オプション | |
| クエリ | 比較フィルタ (`==`, `!=`, `<`, `<=`, `>`, `>=`) | |
| クエリ | 配列フィルタ (`array-contains`, `array-contains-any`) | |
| クエリ | メンバーシップフィルタ (`in`, `not-in`) | |
| クエリ | 複合フィルタ (`and()`, `or()`) | |
| クエリ | `orderBy()` (複数フィールド、asc/desc) | |
| クエリ | `limit()`, `limitToLast()` | |
| クエリ | カーソルページネーション (`startAt`, `startAfter`, `endAt`, `endBefore`) | |
| クエリ | コレクショングループクエリ (`collectionGroup()`) | |
| 集計 | `count()`, `sum()`, `average()` | |
| トランザクション | `runTransaction()` | 楽観的ロック + 自動リトライ (最大5回) |
| バッチ | `writeBatch()` (set / update / delete) | SQLite トランザクションで原子性を保証 |
| リアルタイム | `onSnapshot()` (ドキュメント / クエリ) | WebSocket ベース |
| リアルタイム | `DocumentChange` (added / modified / removed) | |
| リアルタイム | `onSnapshotsInSync()` | |
| FieldValue | `serverTimestamp()` | |
| FieldValue | `increment()` | |
| FieldValue | `arrayUnion()`, `arrayRemove()` | |
| FieldValue | `deleteField()` | |
| データ型 | `string`, `number`, `boolean`, `null` | |
| データ型 | `Timestamp` | |
| データ型 | `GeoPoint` | |
| データ型 | `Bytes` | Base64 エンコーディング |
| データ型 | `DocumentReference` | パスベース |
| データ型 | ネストした Map / Array | |
| コレクション | サブコレクション (多階層) | |
| コレクション | 自動ID生成 | nanoid 使用 |
| セキュリティ | セキュリティルール (完全なパーサー + 評価エンジン) | AST ベース |
| セキュリティ | `request.auth`, `resource.data`, `request.resource.data` | |
| セキュリティ | ワイルドカード変数、再帰ワイルドカード (`{document=**}`) | |
| セキュリティ | カスタム関数定義 | |
| セキュリティ | 組み込み関数 (`get()`, `exists()`, `debug()`) | |
| セキュリティ | 型メソッド (string, list, map, set, timestamp, duration, latlng, bytes) | |
| セキュリティ | 名前空間 (math, hashing, timestamp, duration, latlng) | |
| 変換 | `FirestoreDataConverter` / `withConverter()` | |
| オフライン | `WriteQueue` (オフラインキュー + 自動フラッシュ) | |
| 管理 | データエクスポート / インポート (JSON) | |
| 管理 | Admin UI (コレクション一覧、ドキュメント閲覧・編集) | |
| 管理 | ヘルスチェック / メトリクス | |

---

## 未実装機能

### アプリケーション機能 (実装検討対象)

| 機能 | 本家 Firestore の説明 | 影響度 |
|------|----------------------|--------|
| **複合インデックス定義** | 複数フィールドにまたがるクエリに必要なインデックスの定義・管理。本家では未定義のインデックスを使うクエリはエラーになる | **高** — 本実装では SQLite が暗黙的に処理するため、本番移行時にインデックス不足に気づかないリスクがある |
| **Cloud Functions トリガー** | ドキュメントの `onCreate`, `onUpdate`, `onDelete`, `onWrite` イベントに応じたサーバーサイド処理 | **高** — サーバーサイドロジックのテストが不可 |
| **TTL (Time-to-Live)** | 指定フィールドの Timestamp を基に、期限切れドキュメントを自動削除するポリシー | **中** — 一時データの自動クリーンアップが不可 |
| **マルチデータベース** | 1プロジェクト内で複数の Firestore データベースインスタンスを作成・管理する機能 | **中** — マルチテナント構成で必要 |
| **ベクトル検索** | ベクトル埋め込みフィールドの格納と `FindNearest` による KNN 類似検索 | **中** — AI/ML 連携での類似検索が不可 |
| **データバンドル** | クエリ結果を事前にパッケージ化し、CDN 経由で配信する仕組み | **低** — パフォーマンス最適化向け |
| **パイプラインクエリ** | Firestore Pipeline API (プレビュー段階) | **低** — 本家でもプレビュー機能 |

### クラウドインフラ依存機能 (スコープ外)

以下はクラウドインフラに依存するため、ローカルエミュレータのスコープ外と位置づける。

| 機能 | 説明 |
|------|------|
| マルチリージョン / レプリケーション | データのリージョン分散・レプリカ構成 |
| IAM 統合 | Google Cloud IAM によるアクセス制御 |
| 監査ログ | Cloud Audit Logs との統合 |
| Point-in-time Recovery (PITR) | 過去の時点へのデータ復元 |
| BigQuery 連携 | Firestore データの BigQuery 自動エクスポート |
| Firebase Extensions 連携 | Firestore トリガーによる拡張機能 |
| Datastore モード | Firestore in Datastore mode 互換 |
| フルテキスト検索 | ネイティブ全文検索 (本家でも外部サービス推奨) |

---

## 実装上の差異 (動作は同等だが内部実装が異なるもの)

| 項目 | 本家 Firestore | local-firestore |
|------|---------------|-----------------|
| ストレージ | Bigtable + Spanner | SQLite (better-sqlite3) |
| リアルタイム通信 | gRPC ストリーム | WebSocket |
| ID 生成 | ランダム20文字 (base62) | nanoid |
| トランザクション | サーバーサイド楽観的ロック | SQLite トランザクション + バージョンベースの競合検出 |
| クエリ実行 | 分散インデックススキャン | SQL クエリ (json_extract) |
| 認証 | Firebase Authentication / Google Cloud Identity | カスタム認証プロバイダー |

---

## 補足: 複合インデックスの差異について

本家 Firestore では、以下のようなクエリには複合インデックスの事前定義が必要:

- 複数フィールドの `where` + `orderBy` の組み合わせ
- 異なるフィールドでの範囲フィルタの組み合わせ
- `array-contains` / `array-contains-any` と他フィールドのフィルタの組み合わせ

local-firestore では SQLite がこれらを暗黙的に処理するため、インデックス未定義でもクエリが成功する。本番環境への移行時には、使用しているクエリパターンに対応する複合インデックスの定義が必要となる点に注意が必要。
