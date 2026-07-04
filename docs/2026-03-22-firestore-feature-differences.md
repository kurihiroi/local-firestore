# Google Cloud Firestore との機能差分

本ドキュメントでは、local-firestore と Google Cloud Firestore の機能差分を整理する。

> **更新履歴**: 2026-03-22 初版。2026-07-04 全面更新 — plan.md の Phase 1〜6 実装完了を反映
> （初版で「未実装」だった項目の大半が実装済みになった）。
> 2026-07-04 追記 — Firestore 互換性修正（特殊型の round-trip、クエリ比較セマンティクス、
> updateDoc ドット記法、setDoc 深いマージ、クライアント認証トークン送信）を反映。
> 2026-07-04 追記2 — セキュリティルールの全エンドポイント適用（クエリ / 集計 / バッチ /
> トランザクション / WebSocket リスナー）、`connectFirestoreEmulator()`、
> `getFirestore(app)` の FirebaseApp 連携、スナップショットカーソルを反映。

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
| クエリ | カーソルページネーション (`startAt`, `startAfter`, `endAt`, `endBefore`) | フィールド値と `DocumentSnapshot` の両形式に対応 |
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
| セキュリティ | セキュリティルール (完全なパーサー + 評価エンジン) | AST ベース。ドキュメント CRUD（get / list / create / update / delete）、クエリ / 集計（`list`）、バッチ / トランザクション（各オペレーションを `create` / `update` / `delete` として評価）、WebSocket リスナー（`subscribe_doc` → `get`、`subscribe_query` → `list`）に適用。CLI は `RULES_PATH` でルール JSON を読み込む |
| セキュリティ | クライアント SDK の認証トークン送信 (`FirestoreSettings.authTokenProvider`) | `Authorization: Bearer` ヘッダー + WebSocket subscribe メッセージの `authToken` で送信。サーバー側 `AUTH_PROVIDER=firebase` で Firebase Auth の ID トークンとして検証 |
| セキュリティ | `getFirestore(app)` の FirebaseApp 連携 | `firebase/auth`（optional peer dependency）の ID トークンを自動送信。インスタンスは app + databaseId ごとにキャッシュ |
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
| トリガー | Cloud Functions 風トリガー (`onCreate` / `onUpdate` / `onDelete` / `onWrite`) | Webhook (`POST /triggers`) + Node.js API の2方式。本家 emulator プロトコル互換はなし |
| インデックス | 複合インデックス定義のバリデーション (`IndexManager`) | `firestore.indexes.json` 互換。`strict` / `warn` モード |
| TTL | TTL ポリシーによる期限切れドキュメントの自動削除 (`TtlService`) | 削除時はリスナー通知・トリガーも発火 |
| マルチDB | マルチデータベース (`DatabaseManager`, `/databases/:dbId/*`, `getFirestore(app, databaseId)`) | データベースIDごとに独立した SQLite ファイル |
| ベクトル | ベクトル検索 (`VectorValue` / `vector()` / `findNearest()`) | EUCLIDEAN / COSINE / DOT_PRODUCT |

---

## 未実装機能

### アプリケーション機能

| 機能 | 本家 Firestore の説明 | 影響度 |
|------|----------------------|--------|
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
| クエリ実行 | 分散インデックススキャン | SQL クエリ + Firestore 互換ソートキー（`firestore_key` UDF）。型順序（null < boolean < number < Timestamp < string < Bytes < Reference < GeoPoint < array < Vector < map）、orderBy の欠損フィールド除外、`__name__` 暗黙タイブレーク、範囲フィルタの型ブラケット、複数 orderBy カーソルの辞書式比較に対応 |
| 認証 | Firebase Authentication / Google Cloud Identity | ローカル認証プロバイダー（`Bearer <uid>`、開発用）または Firebase Auth ID トークン検証（`AUTH_PROVIDER=firebase`、firebase-admin 使用）。クライアントは `authTokenProvider` でトークンを送信 |

---

## 補足: 複合インデックスの差異について

本家 Firestore では、以下のようなクエリには複合インデックスの事前定義が必要:

- 複数フィールドの `where` + `orderBy` の組み合わせ
- 異なるフィールドでの範囲フィルタの組み合わせ
- `array-contains` / `array-contains-any` と他フィールドのフィルタの組み合わせ

local-firestore ではクエリ自体は SQLite が暗黙的に処理するため、インデックス未定義でも実行できる。
本番移行時のインデックス不足に気づけるよう、`IndexManager` が `firestore.indexes.json` の定義と
クエリを突き合わせて検証する（`strict` モードでは本家同様エラー、`warn` モードでは警告ログのみ）。

---

## クライアント SDK (TypeScript) の API 互換性

本家 Firebase Web SDK v9+ (`firebase/firestore`) との API レベルの差分を整理する。

### 関数の互換性

#### 実装済み (本家と同等のシグネチャ)

| 関数 | 備考 |
|------|------|
| `getFirestore()` | `FirestoreSettings` または本物の `FirebaseApp` を受け取る。FirebaseApp の場合は `firebase/auth` のトークンを自動配線し、同一インスタンスを返す（本家互換） |
| `connectFirestoreEmulator()` | 接続先ホスト/ポートの差し替え + `mockUserToken`（文字列 / オブジェクト）対応。使用開始後の呼び出しは本家同様エラー |
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
| `terminate()` | WebSocket 切断 + pending 操作の中断 |
| `enableNetwork()` / `disableNetwork()` | 無効化時は WriteQueue にエンキュー、有効化時にフラッシュ |
| `waitForPendingWrites()` | |
| `setLogLevel()` | `'debug' \| 'error' \| 'silent'` |
| `documentId()` | `where(documentId(), '==', ...)` に対応 |
| `refEqual()` / `queryEqual()` / `snapshotEqual()` | |
| `vector()` | `VectorValue` の作成 |
| `findNearest()` | KNN ベクトル検索（本家は Pipeline/Admin SDK 側の API） |

#### 未実装の関数

| 関数 | 本家の用途 | 備考 |
|------|-----------|------|
| `getDocFromCache()` / `getDocsFromCache()` | キャッシュからの取得 | `SnapshotCache` はあるが読み取り API 未配線 |
| `getDocFromServer()` / `getDocsFromServer()` | サーバーからの強制取得 | 常にサーバーから取得するため実質 `getDoc` / `getDocs` と同等 |
| `aggregateFieldEqual()` / `aggregateQuerySnapshotEqual()` | 集計系の等値比較 | 低優先度 |
| `loadBundle()` / `namedQuery()` | データバンドル | バンドル機能自体がスコープ外 |
| `setIndexConfiguration()` | インデックス設定 | 本家でも deprecated |
| `clearIndexedDbPersistence()` ほか IndexedDB / キャッシュ管理系 (`enableIndexedDbPersistence`, `persistentLocalCache`, `memoryLocalCache`, GC / TabManager / PersistentCacheIndex 系) | ブラウザ専用のオフライン永続化 | スコープ外 |
| `documentSnapshotFromJSON()` / `querySnapshotFromJSON()` / `onSnapshotResume()` | SSR/CSR 向けシリアライズ | スコープ外 |

### クラス / インターフェースの差異

#### `DocumentSnapshot`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `id` | プロパティ | getter (互換) |
| `ref` | プロパティ | プロパティ (互換) |
| `exists()` | メソッド | メソッド (互換) |
| `data()` | `data(options?: SnapshotOptions)` | 互換（ローカルではサーバータイムスタンプが常に解決済みのため options は no-op） |
| `get(fieldPath)` | フィールド値を取得 | 互換（ドット記法 / `FieldPath` 対応） |
| `metadata` | `SnapshotMetadata` (hasPendingWrites, fromCache) | 互換（常に `false` / `false`） |

#### `QueryDocumentSnapshot`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `ref` | `DocumentReference` | 互換 |
| `data()` | `data(options?: SnapshotOptions)` | 互換（options は no-op） |
| `get(fieldPath)` | フィールド値を取得 | 互換 |

#### `QuerySnapshot`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `metadata` | `SnapshotMetadata` | 互換（常に `false` / `false`） |
| `query` | 元のクエリを返す | 互換 |
| `docChanges()` | `docChanges(options?)` | 互換（`includeMetadataChanges` は no-op） |

#### `DocumentReference` / `CollectionReference`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `firestore` | `Firestore` | 互換（getter。後方互換のため `_firestore` も維持） |
| `converter` | `FirestoreDataConverter \| null` | 互換（getter。後方互換のため `_converter` も維持） |

#### `Timestamp`

| メンバー | 本家 | local-firestore |
|---------|------|-----------------|
| `toJSON()` | `{seconds, nanoseconds}` を返す | 互換 |
| `toString()` | 文字列表現 | 互換 |

#### `onSnapshot` のオプション

| オプション | 本家 | local-firestore |
|-----------|------|-----------------|
| `SnapshotListenOptions` / `includeMetadataChanges` | メタデータ変更も通知 | 型互換（ローカルでは metadata が変化しないため no-op） |
| Observer オブジェクト形式 | `{ next, error, complete }` | 互換。`complete` は呼ばれない（本家も同様 — スナップショットのストリームは終了しないため） |

#### `updateDoc` の引数形式

| 形式 | 本家 | local-firestore |
|------|------|-----------------|
| `updateDoc(ref, data)` | 対応（`UpdateData<T>`） | 対応（`UpdateData<T>`。ドット記法キーも型付け） |
| `updateDoc(ref, field, value, ...)` | フィールドパス + 値のペアで更新 | 対応 |

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
| `SnapshotOptions` | スナップショットのデータ取得オプション | 互換（no-op） |
| `SnapshotMetadata` | hasPendingWrites, fromCache | 互換 |
| `SnapshotListenOptions` | includeMetadataChanges, source | 互換（no-op） |
| `Unsubscribe` | 互換 | 互換 |
| `UpdateData<T>` | ネストフィールドのドット記法対応 | 互換 |
| `FirestoreError` | extends Error, code プロパティ | 互換 |
| `QueryConstraintType` | クエリ制約の判別用リテラル型 | 互換 |
| `QueryFilterConstraint` | フィルタ制約のユニオン型 | 互換 |
| `QueryNonFilterConstraint` | 非フィルタ制約のユニオン型 | 互換 |
| `ListenSource` | リスナーのソース指定 (`'default' \| 'cache'`) | 互換（no-op） |
| `TaskState` | バンドル読み込みのタスク状態 | **未実装** (バンドル機能自体がスコープ外) |

### 未実装のクラス

| クラス | 本家の用途 |
|--------|-----------|
| `FieldValue` | FieldValue センチネルのベースクラス。local-firestore では関数が直接 `FieldValueSentinel` オブジェクトを返す |
| `LoadBundleTask` | データバンドル読み込みタスク（バンドル機能自体がスコープ外） |
| `PersistentCacheIndexManager` | 永続キャッシュインデックスの管理（ブラウザ専用のためスコープ外） |
| `QueryCompositeFilterConstraint` ほか個別の制約クラス群 | local-firestore では `QueryConstraint` インターフェースで統一 |

### Tree Shaking 対応状況

| 項目 | 本家 SDK | local-firestore |
|------|---------|-----------------|
| ESM 出力 | 対応 | 対応 (tsup で `esm` / `cjs` デュアル出力) |
| `"sideEffects": false` | `package.json` に設定済み | 対応（shared / client / server に設定済み） |
| コード分割 | エントリポイントごとに分割 (`firebase/firestore` / `firebase/firestore/lite`) | server のみ ESM ビルドで `splitting: true`（複数エントリのため）。shared / client は単一エントリのため不要 |
| `"module"` / `"exports"` フィールド | 対応 | 対応 |

### 独自拡張 (本家にない機能)

| 機能 | 説明 |
|------|------|
| `ConnectionManager` | WebSocket 接続管理 (自動再接続、状態監視) |
| `SnapshotCache` | クライアントサイドのスナップショットキャッシュ |
| `WriteQueue` | オフライン書き込みキュー (エンキュー、フラッシュ、リトライ) |
| `getConnectionManager()` | 接続マネージャーの取得 |

### 移行時の注意点

1. **`SnapshotMetadata` の値は常に固定** — `hasPendingWrites` / `fromCache` は API としては存在するが常に `false`。これらの値の変化に依存するロジック（`includeMetadataChanges` を使った再描画制御など）はローカルでは検証できない
2. **`onSnapshot` の `complete` は呼ばれない** — 本家 SDK と同一の挙動（スナップショットのストリームは終了しない）だが、`complete` に処理を書いても実行されない点に注意
3. **`getFirestore()` の第1引数** — 本家同様に `FirebaseApp` を渡して `connectFirestoreEmulator(db, host, port)` で接続先を指定できる（本家からの移行コードがそのまま動く）。local-firestore 独自の `FirestoreSettings`（ホスト/ポート/authTokenProvider）を直接渡す形式も引き続き利用可能
4. **キャッシュ系 API** — `getDocFromCache()` / `getDocsFromCache()` 等は未実装。読み取りは常にサーバー（ローカルプロセス）から行われる
5. **トリガーのプロトコル** — トリガーは Webhook / Node.js API で登録する独自方式であり、本家 Cloud Functions emulator のデプロイプロトコルとは互換性がない
6. **特殊型は本家同様に round-trip する** — `Timestamp` / `GeoPoint` / `Bytes` / `VectorValue` / `DocumentReference` / `Date` は書き込み時に `{__type, ...}` ラッパーへ変換され、読み取り時（`getDoc` / `getDocs` / `onSnapshot` / `transaction.get`）にクラスインスタンスへ復元される。`data().createdAt.toDate()` のようなコードがそのまま動く
7. **旧形式データの非互換** — この修正以前に保存されたデータでは、クライアントから書き込んだ `Timestamp` が素の `{seconds, nanoseconds}` マップとして保存されている。旧データは復元・クエリ比較の対象にならないため、既存の SQLite ファイルは作り直す（または再インポートする）ことを推奨
8. **セキュリティルールの適用範囲** — ドキュメント CRUD に加え、クエリ / 集計 / バッチ / トランザクション / WebSocket リスナーにも適用される。クエリ・集計は `list` ルールで評価される（本家のようにクエリ条件からルール充足を証明する方式ではなく、コレクションパスに対する `list` 許可の判定）。コレクショングループクエリはグループ ID をコレクションパスとして評価する近似実装
