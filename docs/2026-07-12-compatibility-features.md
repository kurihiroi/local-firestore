# Firestore 互換機能の説明

local-firestore が実装している本家 Firestore（Firebase Web SDK v9+ / `firebase/firestore`）
互換機能の説明。旧 `plan.md`（残課題と修正計画）の完了ログを機能説明として再編したもので、
`plan.md` は本ドキュメントの作成をもって廃止した。

- 機能の一覧・未実装機能のカタログ: docs/2026-03-22-firestore-feature-differences.md
- アーキテクチャ: docs/2026-03-15-architecture.md
- クライアント API リファレンス: docs/2026-03-15-client-api-reference.md
- レイテンシ補償の設計: docs/2026-07-07-latency-compensation-design.md
- **未解決の課題**: GitHub Issues [#39〜#62](https://github.com/kurihiroi/local-firestore/issues)
  （2026-07-12 の差し替え運用課題調査で登録。タイトルの `[G-*]` データ・クエリ意味論 /
  `[H-*]` セキュリティルール / `[I-*]` クライアント SDK / `[J-*]` 運用・性能・信頼性）

---

## 1. データ型とシリアライズ

- **特殊型の round-trip**: Timestamp / GeoPoint / Bytes / VectorValue / DocumentReference /
  Date は `{__type: ...}` ラッパーでシリアライズを統一し、読み取り時に対応する
  クラスインスタンスへ復元される。
- **Timestamp のマイクロ秒精度**: 本家仕様どおり、サーバーの全書き込みパスで
  ナノ秒をマイクロ秒精度へ切り捨てる。`createTime` / `updateTime` もマイクロ秒精度
  （小数 6 桁の ISO 文字列）で生成し、クライアントの `Timestamp.fromISO()` は
  小数 9 桁までを丸めずにパースする。
- **非有限数値**: NaN / Infinity / -Infinity は
  `{__type: "double", value: "NaN" | "Infinity" | "-Infinity"}` のワイヤ表現で
  round-trip する。ソート順は NaN が数値の最小（-Infinity より小さい）で、
  `== NaN` フィルタも本家同様にマッチする。ルール評価エンジン・サイズ計算も対応。
- **int64 / double のタグ付き区別はしない**: 本家 Web SDK 自体が JS number（double）に
  透過なため実装しない。2^53 超の整数精度は本家 Web SDK と同等の挙動。
- **`deleteField()` センチネル**: プロトコル表現は `{__type: "delete"}`
  （旧文字列 `"$$__DELETE__$$"` は廃止。同じ文字列値の書き込みとの衝突を解消）。
  merge なし set / addDoc での `deleteField()` はエラー、update のネストマップ内の
  `deleteField()` もエラー（本家準拠）。存在しないドキュメントへの merge set では
  マーカーを除去する。

## 2. クエリセマンティクス

- **Firestore 互換ソートキー（`firestore_key` UDF）**: 型順序
  （null < boolean < number < Timestamp < string < Bytes < Reference < GeoPoint <
  array < Vector < map）、範囲フィルタの型ブラケット、`!=` / `not-in` の null・欠損除外、
  orderBy の欠損フィールド除外、`__name__` 暗黙タイブレーク、不等式フィルタの暗黙ソート、
  複数 orderBy カーソルの辞書式タプル比較、`array-contains(-any)` の Firestore 等値に対応。
- **`__name__` のセグメント順比較**: コレクショングループクエリを含め、`__name__` の
  ORDER BY / カーソル比較は `pathOrderKey`（shared）+ `firestore_path_key` UDF（server）
  によるパスセグメント単位の比較で行う（生文字列比較では `"-"` 等を含む ID で本家と
  食い違うため）。query-matcher も同一キーを使用し、サーバーとのパリティをテストで検証済み。
- **カーソル**: `startAt` / `startAfter` / `endAt` / `endBefore` はフィールド値と
  `DocumentSnapshot` / `QueryDocumentSnapshot` の両形式に対応。スナップショットは
  orderBy フィールドの値 + `__name__` タイブレークへ展開され、同値ドキュメントも
  正しくスキップされる。
- **limit**: `limitToLast` は orderBy 必須（本家準拠のバリデーション）。limit の
  重複指定は最後が有効。
- **集計（count / sum / avg）**: `sum()` / `avg()` は SQLite の `json_type()` で
  数値フィールド（integer / real）のみを集計対象に絞る（本家準拠。文字列が 0 扱いに
  なったり avg の分母に混入したりしない）。
- **クエリバリデーション**: `in` / `array-contains-any` の 30 要素制限、`not-in` の
  10 要素制限、空配列、`array-contains` 複数、`not-in` 複数、`not-in` と `!=` / `in` /
  `array-contains-any` の併用を、クライアント（`getDocs` 前の早期エラー）とサーバー
  （`/query` / `/aggregate` の防御的検証）の両方で拒否する。検証ロジックは
  `packages/shared/src/query-validation.ts` で共有。

## 3. 書き込みセマンティクス

- **`updateDoc` ドット記法**: リーフのみ更新し兄弟フィールドを保持する。
- **`setDoc` merge**: 深いマージ。`mergeFields` オーバーロードあり。
- **FieldValue センチネル**: ネストしたマップ内・ドット記法パスでも解決される。
  `arrayUnion` / `arrayRemove` は深い等値比較で動作する。
- **書き込みバリデーション**: 配列内（`arrayUnion` / `arrayRemove` の要素を含む）の
  FieldValue センチネルはエラー。`undefined` 値はデフォルトでエラーで、
  `FirestoreSettings.ignoreUndefinedProperties` を実装（配列内の undefined は
  本家同様オプションでも許容しない）。

## 4. プラットフォームリミット

`packages/shared/src/limits.ts` に本家「ストレージサイズの計算」仕様のドキュメント
サイズ計算を実装している。

- 1 MiB 超のドキュメント、マップ / 配列のネスト深度 20 超、予約フィールド名（`__.*__`）を
  サーバーの全書き込みパス（setDoc / addDoc / updateDoc / batch / transaction）で
  `invalid-argument` として拒否。
- バッチ / トランザクションの 500 オペレーション超をクライアント（早期）と
  サーバー（防御）の両方でエラーにする。

## 5. セキュリティルール

- **評価エンジン**: 独自パーサー + AST 評価。ドキュメント CRUD
  （get / list / create / update / delete）、クエリ / 集計（`list`）、バッチ /
  トランザクション（各オペレーションを create / update / delete として評価。`set` は
  既存ドキュメントの有無で判定）、WebSocket リスナー（`subscribe_doc` → get、
  `subscribe_query` → list）に適用される。CLI は `RULES_PATH` 環境変数でルール JSON を
  読み込む（本家 CEL テキスト形式は未対応 → Issue #45）。
- **特殊型変換**: `resource.data` / `request.resource.data` / `get()` の返り値内の
  `{__type: "timestamp" | "geopoint" | "bytes" | "reference" | "vector"}` ラッパーを
  ルール型（timestamp / latlng / bytes / path / list）へ変換してから束縛する。
  timestamp メソッド・比較・duration 演算が本家仕様で動作する。
- **`list` の per-document 評価**: ルールが `resource` / `documentId` を参照する場合
  （静的解析で判定。参照しなければ 1 回評価にショートカット）、返却対象の各ドキュメントで
  `resource` を実データ束縛して評価し、1 件でも拒否があればクエリ全体を
  `permission-denied` にする。空結果はコレクションパスで 1 回評価（`resource == null`）。
  `request.query`（limit / offset / orderBy）をコンテキストに束縛。WebSocket リスナーは
  変更通知でも追加・変更ドキュメントを評価し、拒否に転じた場合は `permission-denied` を
  送って購読を終了する。
  ※ 本家の「制約からの静的証明」とは方式が異なる実用近似（差分の詳細は Issue #47）。
- **コレクショングループの実パス評価**: per-document 評価で得た実ドキュメントパスで
  ルールをマッチさせる。`{name=**}` 再帰ワイルドカードは本家 rules_version = '2' と
  同様に複数セグメント（0 個以上、貪欲 + バックトラック）を消費できる。
- **リソース制限**: `get()` / `exists()` の合計 10 回上限、カスタム関数の呼び出し
  スタック深さ 20 上限。評価エラーは拒否（本家と同方向）。

## 6. 認証

- **クライアント → サーバーのトークン送信**: `FirestoreSettings.authTokenProvider` で
  トークンを供給すると、HTTP は `Authorization: Bearer`、WebSocket は subscribe
  メッセージの `authToken` フィールドで送信される。サブスクライブメッセージは
  ファクトリ化されており、再接続時にも最新トークンが送られる。
- **FirebaseApp 連携**: `getFirestore(app)` に本物の `FirebaseApp` が渡された場合、
  `firebase/auth`（optional peer dependency）の `getIdToken()` を自動的に
  `authTokenProvider` として配線する。インスタンスは FirebaseApp ごと・databaseId ごとに
  キャッシュされ、本家と同じく同一インスタンスを返す。
- **サーバー側検証**: `AUTH_PROVIDER=firebase` で Firebase Auth の ID トークンとして
  検証（firebase-admin 使用）。未指定時はローカル認証プロバイダー
  （`Bearer <uid>`、開発用）。
- **`connectFirestoreEmulator()`**: 本家互換シム。接続先ホスト / ポートの差し替えと
  `mockUserToken`（文字列 / オブジェクト）に対応。使用開始後の呼び出しは本家同様エラー。

## 7. クライアント体験（レイテンシ補償・キャッシュ・リスナー）

- **レイテンシ補償**: クライアントに LocalStore（MutationQueue + RemoteDocumentCache +
  overlay 合成）を実装。書き込み API は enqueue 時点でローカルビューへ反映され、
  doc / クエリリスナーが `hasPendingWrites: true` のスナップショットで即時発火し、
  サーバー確定後に `false` へ遷移する。センチネルはローカル推定値で解決
  （serverTimestamp → クライアント時刻、increment → キャッシュ値ベース）。
  失敗時はロールバック + Promise reject。クエリは shared の QueryMatcher
  （filter / orderBy / cursor / limit）でローカル再評価され、docChanges の種別・
  インデックスまで合成される。
- **SnapshotMetadata**: `hasPendingWrites` / `fromCache` は実値で配線され、
  `includeMetadataChanges` も実装済み。
- **オフライン書き込み**: MutationQueue に統合されており、オフライン中の書き込みも
  ローカルビューへ即時反映される。書き込み Promise は本家同様サーバー確定まで pending。
  `waitForPendingWrites()` は全 mutation の確定待ち。
  ※ ストアは純インメモリでリロードで消失する点、一過性エラーの再送がない点は
  未解決（Issue #50 / #52）。
- **キャッシュ読み取り API**: `getDocFromCache()` / `getDocsFromCache()` を
  ローカルビューで実装（未命中は `unavailable`、metadata は `fromCache: true`、
  pending write も反映）。`getDoc` / `getDocs` / リスナーの結果がキャッシュを温める。
  `getDocFromServer` / `getDocsFromServer` エイリアスもある。
- **再接続時の差分スナップショット**: docChanges は常にクライアント保持の前回発火結果
  との差分で合成される（サーバーの changes フィールドは不使用）。再接続時のフル再購読が
  自然に差分となり、切断中に消えたドキュメントが `removed` として届く。
- **比較ユーティリティ**: `snapshotEqual` / `refEqual` / `queryEqual` /
  `aggregateFieldEqual` / `aggregateQuerySnapshotEqual` を実装済み。

## 8. 運用機能

- **多重起動ガード**: 起動時に `<DB_PATH>.lock` ロックファイル（PID + タイムスタンプ）を
  作成し、生存プロセスの二重起動を `ProcessLockError` で拒否する。異常終了後の
  stale ロックは検出して自動回収する。制約は「1 プロセス = 1 SQLite ファイル」
  （docs/2026-03-15-architecture.md の「前提」参照）。
- **at-rest 暗号化**: `DB_ENCRYPTION_KEY` 環境変数指定時に
  `better-sqlite3-multiple-ciphers` で暗号化 DB を開く。マルチデータベース・
  `migrate` サブコマンドにも同じ鍵が適用される。鍵の誤り / 暗号化有無の不一致は
  起動時に `DatabaseOpenError` で検出。既存 DB の暗号化変換は export → import 経路で行う。
- **TLS**: `TLS_CERT_PATH` / `TLS_KEY_PATH` で HTTPS / WSS を有効化。
- **マイグレーション**: `local-firestore migrate [--dry-run]` CLI サブコマンド
  （`DB_PATH` で対象を指定）。素の `{seconds, nanoseconds}` マップ →
  `{__type: "timestamp"}` 変換、ナノ秒のマイクロ秒切り捨て、旧 `"$$__DELETE__$$"`
  残存値の検出レポート（自動変換はしない）を実行する。version / updateTime は変更しない。
  `/import` 経路でも同じ正規化が適用されるため export → import での移行も可能。
- **マルチデータベース**: `DatabaseManager` / `/databases/:dbId/*` /
  `getFirestore(app, databaseId)`。データベース ID ごとに独立した SQLite ファイル。
- **その他**: TTL ポリシーによる自動削除（`TtlService`）、Cloud Functions 風トリガー
  （Webhook + Node.js API の 2 方式）、JSON エクスポート / インポート、Admin UI、
  ヘルスチェック / メトリクス、複合インデックス定義のバリデーション（`IndexManager`、
  `firestore.indexes.json` 互換、strict / warn モード）、ベクトル検索（`findNearest()`）。

---

## スコープ外(実装しない項目)

クラウドインフラ依存または本家でも非推奨 / プレビューのため、実装対象外とする:

- クラウドインフラ依存機能(マルチリージョン、IAM、監査ログ、PITR、BigQuery 連携等)
- 水平スケール(マルチプロセス / マルチインスタンス構成) — ローカル用途のため
  単一プロセス制約を維持し、ガードと明文化のみ行う
- 本家 Cloud Functions emulator のトリガープロトコル互換 — 現行の Webhook /
  Node.js API 方式を維持する
- IndexedDB 関連 API(`clearIndexedDbPersistence`, `enableIndexedDbPersistence` 等) — ブラウザ専用機能
- データバンドル(`loadBundle`, `namedQuery`)、パイプラインクエリ — 本家でもプレビュー / 低需要
- キャッシュ管理 API(`persistentLocalCache`, `memoryLocalCache` 等) — ブラウザ専用
- SSR/CSR 向け API(`documentSnapshotFromJSON`, `querySnapshotFromJSON`, `onSnapshotResume`) — 特殊用途
- `FieldValue` ベースクラス — 現在の `FieldValueSentinel` アプローチで十分
- 個別の QueryConstraint サブクラス群 — 現在の `QueryConstraint` インターフェースで統一済み
- `offset()` クエリ演算子 — 本家 Web SDK も非提供(Admin SDK 専用)のため実装しない
- int64 / double のタグ付き区別 — 本家 Web SDK 自体が JS number に透過なため実装しない
