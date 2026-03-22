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

---

## クライアント SDK (TypeScript) の API 互換性

本家 Firebase Web SDK v9+ (`firebase/firestore`) との API レベルの差分を整理する。

### 関数の互換性

#### 実装済み (本家と同等のシグネチャ)

| 関数 | 備考 |
|------|------|
| `getFirestore()` | 引数が `FirestoreSettings` (本家は `FirebaseApp`) |
| `initializeFirestore()` | 第1引数 `_app` を受け取るが無視する |
| `doc()` | `Firestore \| CollectionReference` を受け取る |
| `collection()` | `Firestore \| DocumentReference` を受け取る |
| `getDoc()` | |
| `getDocs()` | |
| `setDoc()` | `merge` / `mergeFields` オーバーロードあり |
| `addDoc()` | |
| `updateDoc()` | |
| `deleteDoc()` | |
| `query()` | |
| `where()` | |
| `orderBy()` | |
| `limit()` / `limitToLast()` | |
| `startAt()` / `startAfter()` / `endAt()` / `endBefore()` | |
| `and()` / `or()` | |
| `collectionGroup()` | |
| `onSnapshot()` | ドキュメント / クエリ両対応 |
| `onSnapshotsInSync()` | |
| `writeBatch()` | |
| `runTransaction()` | `TransactionOptions` 対応 |
| `serverTimestamp()` / `deleteField()` / `increment()` | |
| `arrayUnion()` / `arrayRemove()` | |
| `count()` / `sum()` / `average()` | |
| `getCountFromServer()` / `getAggregateFromServer()` | |

#### 未実装の関数

| 関数 | 本家の用途 |
|------|-----------|
| `connectFirestoreEmulator()` | エミュレータ接続設定 |
| `terminate()` | Firestore インスタンスの終了 |
| `clearIndexedDbPersistence()` | IndexedDB キャッシュのクリア |
| `enableIndexedDbPersistence()` | IndexedDB オフライン永続化の有効化 |
| `enableMultiTabIndexedDbPersistence()` | マルチタブ対応のオフライン永続化 |
| `enableNetwork()` / `disableNetwork()` | ネットワーク接続の有効化/無効化 |
| `waitForPendingWrites()` | 保留中の書き込み完了を待機 |
| `loadBundle()` | データバンドルの読み込み |
| `namedQuery()` | バンドル内の名前付きクエリの取得 |
| `documentId()` | `where` フィルタでドキュメントIDを指定する特殊フィールド |
| `getDocFromCache()` | キャッシュからのドキュメント取得 |
| `getDocFromServer()` | サーバーからの強制取得 |
| `getDocsFromCache()` | キャッシュからのクエリ結果取得 |
| `getDocsFromServer()` | サーバーからの強制クエリ実行 |
| `setLogLevel()` | ログレベル設定 |
| `refEqual()` | リファレンスの等値比較 |
| `queryEqual()` | クエリの等値比較 |
| `snapshotEqual()` | スナップショットの等値比較 |
| `aggregateFieldEqual()` | AggregateField の等値比較 |
| `aggregateQuerySnapshotEqual()` | AggregateQuerySnapshot の等値比較 |
| `vector()` | ベクトル埋め込み値の作成 |
| `setIndexConfiguration()` | インデックス設定 (deprecated) |
| `persistentLocalCache()` | IndexedDB ベースのローカルキャッシュ |
| `memoryLocalCache()` | メモリベースのローカルキャッシュ |
| `memoryEagerGarbageCollector()` | メモリキャッシュの即時GC |
| `memoryLruGarbageCollector()` | メモリキャッシュのLRU GC |
| `persistentMultipleTabManager()` | マルチタブ永続化マネージャー |
| `persistentSingleTabManager()` | シングルタブ永続化マネージャー |
| `getPersistentCacheIndexManager()` | 永続キャッシュインデックスマネージャー取得 |
| `enablePersistentCacheIndexAutoCreation()` | クライアントサイドインデックスの自動作成有効化 |
| `disablePersistentCacheIndexAutoCreation()` | クライアントサイドインデックスの自動作成無効化 |
| `deleteAllPersistentCacheIndexes()` | 全永続キャッシュインデックスの削除 |
| `documentSnapshotFromJSON()` | JSON からの DocumentSnapshot デシリアライズ (SSR/CSR) |
| `querySnapshotFromJSON()` | JSON からの QuerySnapshot デシリアライズ (SSR/CSR) |
| `onSnapshotResume()` | シリアライズ状態からのリスナー再開 (SSR/CSR) |

### クラス / インターフェースの差異

#### `DocumentSnapshot`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `id` | プロパティ | getter (互換) |
| `ref` | プロパティ | プロパティ (互換) |
| `exists()` | メソッド | メソッド (互換) |
| `data()` | `data(options?: SnapshotOptions)` | `data()` — `SnapshotOptions` 未対応 |
| `get(fieldPath)` | フィールド値を取得 | **未実装** |
| `metadata` | `SnapshotMetadata` (hasPendingWrites, fromCache) | **未実装** |

#### `QueryDocumentSnapshot`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `ref` | `DocumentReference` | **未実装** — `path` と `id` のみ |
| `data()` | `data(options?: SnapshotOptions)` | `data()` — `SnapshotOptions` 未対応 |
| `get(fieldPath)` | フィールド値を取得 | **未実装** |

#### `QuerySnapshot`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `metadata` | `SnapshotMetadata` | **未実装** |
| `query` | 元のクエリを返す | **未実装** |
| `docChanges()` | `docChanges(options?)` | `docChanges()` — `SnapshotListenOptions` 未対応 |

#### `DocumentReference`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `firestore` | `Firestore` | `_firestore` (internal プレフィックス) |
| `converter` | `FirestoreDataConverter \| null` | `_converter` (internal プレフィックス) |

#### `CollectionReference`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `firestore` | `Firestore` | `_firestore` (internal プレフィックス) |
| `converter` | `FirestoreDataConverter \| null` | `_converter` (internal プレフィックス) |

#### `Timestamp`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `toJSON()` | `{seconds, nanoseconds}` を返す | **未実装** |
| `toString()` | 文字列表現 | **未実装** (`valueOf()` はあり) |

#### `onSnapshot` のオプション

| オプション | 本家 | local-firestore |
|-----------|------|-----------------|
| `includeMetadataChanges` | メタデータ変更も通知 | **未対応** |
| `SnapshotListenOptions` | リスナーオプション | **未対応** |
| Observer オブジェクト形式 | `{ next, error, complete }` | **未対応** — 個別引数のみ |

#### `updateDoc` の引数形式

| 形式 | 本家 | local-firestore |
|------|------|-----------------|
| `updateDoc(ref, data)` | 対応 | 対応 |
| `updateDoc(ref, field, value, ...)` | フィールドパス + 値のペアで更新 | **未対応** |

### 型の互換性

| 型 | 本家 | local-firestore |
|----|------|-----------------|
| `DocumentData` | 互換 | 互換 |
| `WithFieldValue<T>` | 互換 | 互換 |
| `PartialWithFieldValue<T>` | 互換 | 互換 |
| `SetOptions` | 互換 | 互換 |
| `FirestoreDataConverter<T>` | 互換 | 互換 |
| `WhereFilterOp` | 互換 | 互換 |
| `OrderByDirection` | 互換 | 互換 |
| `FirestoreErrorCode` | 互換 | 互換 |
| `SnapshotOptions` | スナップショットのデータ取得オプション | **未実装** |
| `SnapshotMetadata` | hasPendingWrites, fromCache | **未実装** |
| `SnapshotListenOptions` | includeMetadataChanges | **未実装** |
| `Unsubscribe` | 互換 | 互換 |
| `UpdateData<T>` | ネストフィールドのドット記法対応 | **未実装** (`Partial<T>` で代替) |
| `FirestoreError` | extends Error, code プロパティ | 互換 |
| `QueryConstraintType` | クエリ制約の判別用リテラル型 | **未実装** |
| `QueryFilterConstraint` | フィルタ制約のユニオン型 | **未実装** |
| `QueryNonFilterConstraint` | 非フィルタ制約のユニオン型 | **未実装** |
| `TaskState` | バンドル読み込みのタスク状態 | **未実装** (バンドル機能自体が未実装) |
| `ListenSource` | リスナーのソース指定 (`'default' \| 'cache'`) | **未実装** |

### 未実装のクラス

| クラス | 本家の用途 |
|--------|-----------|
| `FieldValue` | FieldValue センチネルのベースクラス。local-firestore では関数が直接 `FieldValueSentinel` オブジェクトを返す |
| `VectorValue` | ベクトル埋め込み値の型 |
| `LoadBundleTask` | データバンドル読み込みタスク |
| `PersistentCacheIndexManager` | 永続キャッシュインデックスの管理 |
| `SnapshotMetadata` | スナップショットのメタデータ (hasPendingWrites, fromCache) |
| `QueryCompositeFilterConstraint` | 複合フィルタ制約クラス (local-firestore では `QueryConstraint` インターフェースで統一) |
| `QueryFieldFilterConstraint` | フィールドフィルタ制約クラス |
| `QueryOrderByConstraint` | orderBy 制約クラス |
| `QueryLimitConstraint` | limit 制約クラス |
| `QueryStartAtConstraint` | startAt/startAfter 制約クラス |
| `QueryEndAtConstraint` | endAt/endBefore 制約クラス |

### Tree Shaking 対応状況

| 項目 | 本家 SDK | local-firestore |
|------|---------|-----------------|
| ESM 出力 | 対応 | 対応 (tsup で `esm` / `cjs` デュアル出力) |
| `"sideEffects": false` | `package.json` に設定済み | **未設定** — バンドラーが未使用エクスポートを除去できない |
| コード分割 | エントリポイントごとに分割 (`firebase/firestore` / `firebase/firestore/lite`) | **未対応** — tsup の `splitting: false` により単一ファイル出力 |
| `"module"` / `"exports"` フィールド | 対応 | 対応 |

#### 改善方法

1. 各パッケージの `package.json` に `"sideEffects": false` を追加する
2. tsup の `splitting` を `true` に変更し、チャンク分割を有効にする (必要に応じて)

`"sideEffects": false` が未設定のため、利用側のバンドラー (webpack / Rollup / esbuild 等) で tree shaking が十分に機能しない。本家 SDK は `"sideEffects": false` を設定しており、`firebase/firestore/lite` という軽量エントリポイントも提供している。

### 独自拡張 (本家にない機能)

| 機能 | 説明 |
|------|------|
| `ConnectionManager` | WebSocket 接続管理 (自動再接続、状態監視) |
| `SnapshotCache` | クライアントサイドのスナップショットキャッシュ |
| `WriteQueue` | オフライン書き込みキュー (エンキュー、フラッシュ、リトライ) |
| `getConnectionManager()` | 接続マネージャーの取得 |

### 移行時の注意点

1. **`DocumentSnapshot.get(fieldPath)`** — 本家ではフィールドパスによる値取得が可能だが、local-firestore では `data()` でオブジェクト全体を取得して自分でアクセスする必要がある
2. **`updateDoc` のフィールドパス形式** — `updateDoc(ref, "field.nested", value)` の形式が使えない。オブジェクト形式で渡す必要がある
3. **`SnapshotMetadata`** — `hasPendingWrites` や `fromCache` が利用できないため、これらに依存するロジックは移行時に調整が必要
4. **`DocumentReference.firestore` / `converter`** — internal プレフィックス (`_firestore`, `_converter`) が付いているため、直接アクセスしているコードは修正が必要
5. **`documentId()`** — `where` フィルタでドキュメントIDを条件にする場合、本家では `documentId()` を使うが local-firestore では未対応
6. **Observer オブジェクト形式** — `onSnapshot(ref, { next: ..., error: ... })` 形式が使えない。`onSnapshot(ref, onNext, onError)` 形式を使用する必要がある
