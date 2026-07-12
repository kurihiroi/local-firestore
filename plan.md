# 残課題と修正計画

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

2026-07-06 に Phase 1（セキュリティルールの本家セマンティクス化）が完了した:

- **評価エンジンの特殊型変換（A-2）**: `resource.data` / `request.resource.data` /
  `get()` の返り値内の `{__type: "timestamp" | "geopoint" | "bytes" | "reference" | "vector"}`
  ラッパーをルール型（timestamp / latlng / bytes / path / list）へ変換してから束縛。
  timestamp メソッド・比較・duration 演算が本家仕様で動作する
- **`list` 評価の per-document 化（A-1）**: `/query` / `/aggregate` / `subscribe_query` で、
  ルールが `resource` / `documentId` を参照する場合（静的解析で判定、参照しなければ
  従来どおり1回評価にショートカット）は返却対象の各ドキュメントで `resource` を実データ
  束縛して評価し、1件でも拒否があればクエリ全体を `permission-denied` にする。
  空結果はコレクションパスで1回評価（`resource == null`）。`request.query`
  （limit / offset / orderBy、未指定は null / 0）をコンテキストに束縛。
  WebSocket リスナーは変更通知でも追加・変更ドキュメントを評価し、拒否に転じた場合は
  `permission-denied` を送って購読を終了する
- **コレクショングループの実パス評価（A-3）**: per-document 評価で得た実ドキュメントパスで
  ルールをマッチさせる。`{name=**}` 再帰ワイルドカードは本家 rules_version = '2' と同様に
  複数セグメント（0個以上、貪欲 + バックトラック）を消費できる

2026-07-06 に Phase 2（リミット強制とバリデーション）が完了した:

- **プラットフォームリミット（B-1）**: `packages/shared/src/limits.ts` に本家
  「ストレージサイズの計算」仕様のドキュメントサイズ計算を実装し、1 MiB 超・
  マップ / 配列のネスト深度 20 超・予約フィールド名（`__.*__`）をサーバーの全書き込み
  パス（setDoc / addDoc / updateDoc / batch / transaction）で `invalid-argument` として拒否。
  バッチ / トランザクションの 500 オペレーション超をクライアント（早期）と
  サーバー（防御）の両方でエラーにする
- **クエリバリデーション（B-2）**: `in` / `array-contains-any` の 30 要素制限、
  `not-in` の 10 要素制限（本家準拠）、空配列、`array-contains` 複数、`not-in` 複数、
  `not-in` と `!=` / `in` / `array-contains-any` の併用をクライアント
  （`getDocs` 前の早期エラー）とサーバー（`/query` / `/aggregate` の防御的検証）で拒否。
  検証ロジックは `packages/shared/src/query-validation.ts` で共有
- **書き込みバリデーション（B-3）**: 配列内（`arrayUnion` / `arrayRemove` の要素を含む）の
  FieldValue センチネルをエラーに、`undefined` 値をデフォルトでエラーにし、
  `FirestoreSettings.ignoreUndefinedProperties` を実装（配列内の undefined は
  本家同様オプションでも許容しない）
- **`deleteField` センチネルのプロトコル表現化（B-4）**: 内部表現を文字列
  `"$$__DELETE__$$"` から `{__type: "delete"}` に変更し、同じ文字列値の書き込みとの
  衝突（意図しないフィールド削除）を解消。あわせて merge なし set / addDoc での
  `deleteField()` をエラーに、update のネストマップ内の `deleteField()` をエラーに
  （本家準拠）、存在しないドキュメントへの merge set ではマーカーを除去するよう修正

2026-07-07 に Phase 3（データ忠実度）が完了した:

- **Timestamp のマイクロ秒切り捨て（C-2）**: サーバーの全書き込みパスで Timestamp の
  ナノ秒をマイクロ秒精度へ切り捨て。`createTime` / `updateTime` もマイクロ秒精度
  （小数6桁の ISO 文字列）で生成し、クライアントの `Timestamp.fromISO()` は
  小数9桁までのマイクロ秒 / ナノ秒精度を丸めずにパースする
- **sum / avg の非数値スキップ（C-3）**: SQLite の `json_type()` で数値フィールド
  （integer / real）のみを集計対象に絞る SQL に変更。文字列が 0 扱いされる問題と
  avg の分母に非数値が混入する問題を解消
- **数値型の忠実度（C-1）**: NaN / Infinity / -Infinity のワイヤ表現
  （`{__type: "double", value: "NaN" | "Infinity" | "-Infinity"}`）を導入し、
  JSON で null に化けていた非有限数値の round-trip を実現。`firestore_key` で
  NaN を数値の最小（-Infinity より小さい）としてソートし、`== NaN` フィルタも
  本家同様にマッチする。ルール評価エンジン・サイズ計算も対応。
  ※ int64 / double のタグ付き区別は本家 Web SDK 自体が JS number（double）に
  透過なため実装しない（2^53 超の整数精度は本家 Web SDK と同等の挙動）
- **旧形式データのマイグレーション（C-4）**: `local-firestore migrate [--dry-run]`
  CLI サブコマンドを追加（`DB_PATH` で対象を指定）。素の `{seconds, nanoseconds}`
  マップ → `{__type: "timestamp"}` 変換、ナノ秒のマイクロ秒切り捨て、
  旧 `"$$__DELETE__$$"` 残存値の検出レポート（自動変換はしない）を実行し、
  version / updateTime は変更しない。`/import` 経路でも同じ正規化が適用されるため
  export → import での移行も可能

2026-07-13 に Phase 4（クライアント体験のパリティ）が完了した:

- **レイテンシ補償（D-1）**: クライアントに LocalStore（MutationQueue +
  RemoteDocumentCache + overlay 合成）を導入。書き込み API は enqueue 時点で
  ローカルビューへ反映され、doc / クエリリスナーが `hasPendingWrites: true` の
  スナップショットで即時発火し、サーバー確定後に `false` へ遷移する。
  センチネルはローカル推定値で解決（serverTimestamp → クライアント時刻、
  increment → キャッシュ値ベース）。失敗時はロールバック + Promise reject。
  クエリは shared の QueryMatcher（filter / orderBy / cursor / limit）で
  ローカル再評価され、docChanges の種別・インデックスまで合成される。
  `SnapshotMetadata` を実値で配線し `includeMetadataChanges` を実装。
  WriteQueue は MutationQueue に統合され、オフライン書き込みも即時反映・
  書き込み Promise は本家同様サーバー確定まで pending。
  `waitForPendingWrites()` は全 mutation の確定待ちに再定義
- **キャッシュ読み取り API（D-2）**: `getDocFromCache()` / `getDocsFromCache()` を
  ローカルビューで実装（未命中は `unavailable`、metadata は `fromCache: true`、
  pending write も反映）。`getDoc` / `getDocs` / リスナーの結果がキャッシュを温める。
  `getDocFromServer` / `getDocsFromServer` エイリアスも追加
- **再接続時の差分スナップショット（D-3）**: docChanges を常にクライアント保持の
  前回発火結果との差分で合成する方式に統一（サーバーの changes フィールドは不使用）。
  再接続時のフル再購読が自然に差分となり、切断中に消えたドキュメントが
  `removed` として届く

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

---

# 課題一覧（2026-07-04 置き換えリスク調査で全面更新、2026-07-12 再調査で G〜J を追加）

本物の Firestore をこのプロジェクトで置き換える際に問題となる点を、コード調査
（rules-middleware / listener-manager / crud / document service / transaction 等）の結果を
反映して整理した。旧「残課題」の項目もここに統合している。

A〜F は 2026-07-04 調査分（すべて解決済み）。G〜J は Phase 1〜5 完了後の
2026-07-12 再調査で新規検出した未解決の差分。詳細（コード引用・本家挙動・影響）は
docs/2026-07-12-firestore-replacement-issues.md を参照。

## A. セキュリティルールのセマンティクス差（最重要）【2026-07-06 解決済み】

### A-1. `list` 評価が単発のコレクションレベル判定になっている
- **現状**: `/query` / `/aggregate` / `subscribe_query` は `existingData` も `queryParams` も
  渡さずに `list` を一回だけ評価する（`packages/server/src/security/rules-middleware.ts`、
  `websocket.ts`）。そのため:
  - `resource` が `null` に束縛され、`list` ルールが `resource.data` を参照すると評価エラー
    → クエリ全体が一律拒否される
  - `list` ルールが通ると、ドキュメント単位の条件に関係なくマッチした全ドキュメントが返る
    （ドキュメントごとの評価・フィルタは行われない）
  - `request.query`（limit / offset / orderBy）が未束縛でルールから参照できない
- **本家**: クエリ制約がルールを充足すると証明できなければクエリ全体を拒否する
  （per-document のポストフィルタもしない）
- **影響**: 読み取り制御をルールに依存するアプリで許可・拒否の両方向で結果がズレる。
  データ漏えい方向のズレ（全件返却）を含むため最優先

### A-2. ルール評価エンジンの特殊型対応
- **現状**: `resource.data` / `request.resource.data` 内の `{__type: "timestamp", ...}` ラッパーが
  ただのマップとして評価される。ルール内の timestamp メソッド・比較が本家と一致しない
- **内容**: 評価エンジンで `__type` ラッパーを対応するルール型（timestamp / bytes / latlng /
  path）に変換してから評価する
- **対象**: `packages/server/src/security/rules-evaluator/`

### A-3. コレクショングループクエリのルール評価が近似
- **現状**: グループ ID をコレクションパスとして評価する近似実装。
  `match /{path=**}/comments/{id}` のような本家のマッチングと一致しない
- **備考**: A-1 を per-document 評価にすると、実ドキュメントパスでの match が可能になり
  自然に解消できる

## B. 本家ハードリミット・バリデーションの欠如【2026-07-06 解決済み】

### B-1. プラットフォームリミットが一切強制されない
- **現状**: 1 MiB ドキュメントサイズ、バッチ / トランザクションの 500 書き込み、
  マップ / 配列のネスト深度 20、フィールド名制約のチェックがクライアント・サーバーの
  どちらにもない（`document.ts` / `batch.ts` / `transaction.ts` を確認済み）
- **影響**: ローカルで通っていたコードが本番 Firestore で初めて落ちる

### B-2. クエリバリデーションの本家パリティ
- `in` / `not-in` / `array-contains-any` の最大30要素制限
- `array-contains` の複数指定、`not-in` と `!=` の併用等、本家がエラーにする組合せの検出
- 対象: `packages/client/src/query.ts`（クライアント側で早期エラー）+ サーバー側検証

### B-3. 書き込みバリデーション
- 配列内の FieldValue センチネル（本家はエラー）、`undefined` 値（本家はデフォルトでエラー、
  `ignoreUndefinedProperties` オプションあり）の検証

### B-4. `deleteField()` センチネルの文字列衝突
- 内部表現 `"$$__DELETE__$$"` が同じ文字列値の書き込みと衝突しうる（意図しないフィールド
  削除 = データ破損リスク）。センチネルをプロトコルレベルの表現に変更する

## C. データ忠実度【2026-07-07 解決済み】

### C-1. 数値型の忠実度
- 本家は int64 / double を区別する（JS SDK 上は透過的だが、`2^53` 超の整数で精度が変わる）
- NaN の順序（本家: NaN は数値の最小として扱われ、`== NaN` フィルタも可能）
- 対象: `packages/server/src/storage/firestore-key.ts`, シリアライズ層

### C-2. Timestamp のマイクロ秒切り捨て
- 本家はマイクロ秒精度に切り捨てる。現在はナノ秒をそのまま保持
- `Timestamp.fromISO()` がミリ秒精度で丸めるため、`createTime` / `updateTime` の精度も本家と異なる

### C-3. sum / avg の非数値スキップ
- 本家の `sum()` / `avg()` は数値フィールドのみを集計対象にする。
  現在は SQLite の `SUM` / `AVG` の型強制に依存（文字列が 0 扱いになる等）
- 対象: `packages/server/src/services/query.ts`（`firestore_key` の型タグで数値のみに絞る）

### C-4. 旧形式データのマイグレーション
- 2026-07-04 以前に保存されたデータでは、クライアント書き込みの Timestamp が素の
  `{seconds, nanoseconds}` マップになっている。検出して `{__type: "timestamp"}` 形式に
  変換するマイグレーションスクリプト（または export → import での変換）を提供する
- B-4 のセンチネル表現変更に伴うマイグレーションもここに統合する

## D. クライアント体験のパリティ【2026-07-13 解決済み】

### D-1. レイテンシ補償（楽観的ローカル更新）がない
- **現状**: `setDoc` 等はサーバー往復のみで、`onSnapshot` はサーバーからの WebSocket
  スナップショット到着まで発火しない（`packages/client/src/crud.ts`, `listener.ts`）。
  本家 SDK は書き込み直後にローカルリスナーへ即時反映する（`hasPendingWrites: true`）
- **影響**: 書き込み直後の UI 反映を前提にした画面で体感が変わる。
  `SnapshotMetadata`（`hasPendingWrites` / `fromCache`）が常に `false` 固定のため、
  metadata に依存するロジックが検証できない

### D-2. キャッシュ読み取り API の未配線
- `getDocFromCache()` / `getDocsFromCache()`（`SnapshotCache` は存在するが読み取り API 未接続）

### D-3. 再接続時のスナップショット差分
- 再接続時はフル再購読となり、全ドキュメントが `added` として届く（切断中の個別イベントは
  再生されない。最終状態には収束する）。`docChanges()` の変更種別に依存するロジックが
  再接続時に誤動作しうる。`SnapshotCache` との比較で added / modified / removed を
  合成した差分に変換したい
- **備考**: 通知は SQLite コミット後に発火する設計であり、コミット前通知の問題はない
  （`documents.ts` → `listener-manager.ts` の順序を確認済み）

## E. 運用・アーキテクチャ

### E-1. 単一プロセス制約のガードと明文化【解決済み】
- **現状**: better-sqlite3 の同期 API + インメモリのリスナー購読 / OCC 状態のため、
  同一 SQLite ファイルに対して複数サーバープロセスを起動するとリアルタイム通知・
  トランザクション整合性が壊れる。現在は多重起動を防ぐ仕組みがない
- **内容**: 起動時のロックファイル等による多重起動ガード + ドキュメントへの制約明記。
  水平スケール自体はスコープ外（ローカル用途のため）
- **解決**: Phase 5-1 で対応（2026-07-11）。`<DB_PATH>.lock` による多重起動ガード
  （stale ロック自動回収付き）+ architecture ドキュメントへの明文化

### E-2. at-rest 暗号化（要件定義に記載、未実装）【解決済み】
- docs/2026-03-15-requirements.md の非機能要件にあるが未実装（TLS は `TLS_CERT_PATH` /
  `TLS_KEY_PATH` で実装済み）。SQLCipher 系ドライバのオプション対応を検討する
- **解決**: Phase 5-2 で対応（2026-07-11）。`DB_ENCRYPTION_KEY` 指定時に
  `better-sqlite3-multiple-ciphers` で暗号化 DB を開く

## F. 低優先度【解決済み】

- コレクショングループクエリの順序（本家は完全なリソース名順。親パスが異なる場合の順序検証）
  → Phase 5-3 で対応（2026-07-11）。`__name__` の順序をセグメント単位の比較へ修正
- `aggregateFieldEqual()` / `aggregateQuerySnapshotEqual()`
  → Phase 5-3 で実装（2026-07-11）

## G. データ・クエリ意味論の残存差分（2026-07-12 検出、未解決）

### G-1. 文字列順序が UTF-16 コード単位順（本家は UTF-8 バイト順）
- **現状**: `escapeString` が `charCodeAt` で走査し（`packages/shared/src/firestore-key.ts:41-49`）、
  map キー順も `Object.keys().sort()`。サーバー / クライアントは一致するが本家とズレる
- **本家**: UTF-8 バイト順（= コードポイント順）
- **影響**: サロゲートペア（絵文字等）を含む orderBy / 範囲フィルタ / カーソルの順序が食い違う。
  修正はソートキー全体に波及するため migrate と連動が必要

### G-2. serverTimestamp がコミット内で単一時刻に統一されない
- **現状**: `createServerMutationContext().serverTimestamp` が呼び出しごとに `new Date()` を読む
  （`packages/shared/src/mutation-applier.ts:23-36`）。バッチ / トランザクションはオペレーション
  ごとに順次適用されるため、同一コミット内の複数 serverTimestamp が別時刻になる
- **本家**: 1 コミットの全 serverTimestamp は単一のコミット時刻
- **対象**: `packages/server/src/services/transaction.ts`, `document.ts`, mutation-applier

### G-3. 集計クエリが limit / cursor / orderBy を無視する
- **現状**: `executeAggregate` は WHERE のみ構築し LIMIT / カーソルを付けない
  （`packages/server/src/services/query.ts:194-247`）
- **影響**: `count(query(coll, limit(10)))` が全一致件数を返す。sum / avg も同様

### G-4. ドキュメント ID / パスの内容バリデーションが未強制
- **現状**: セグメント数の偶奇のみ検証。ID 1500 バイト・単体 `.` / `..`・空 ID・`__.*__`
  予約 ID・パス全長 6 KiB の検査がない（`packages/client/src/references.ts:21-27`,
  `packages/server/src/utils/path.ts`）
- **影響**: ローカルで通る ID が本番 Firestore で初めて `invalid-argument` になる

### G-5. フィールドパスのバリデーションが本家非準拠
- **現状**: `FieldPath.toString()` がバッククォートエスケープをせず
  （`packages/client/src/types.ts:200-223`）、サーバー `escapePath` は `^[a-zA-Z0-9_.]+$` 以外を
  汎用 Error で拒否（`packages/server/src/services/query.ts:554-559`）
- **影響**: `-` / 空白 / 非 ASCII を含むフィールド名のクエリ不可。ドット入り名がネスト誤解釈

### G-6. findNearest / documentId() のバリデーション・演算子欠落
- findNearest に limit ≤ 1000・次元 2048 上限・distanceMeasure 検証がない
  （`packages/client/src/query.ts:335-343`）
- `documentId()` の範囲比較（`<` `<=` `>` `>=`）が throw
  （`packages/server/src/services/query.ts:391-411`, `packages/shared/src/query-matcher.ts:84-98`）

## H. セキュリティルールの残存差分（2026-07-12 検出、未解決）

### H-1. ルール入力形式が本家 `firestore.rules`（CEL テキスト）と非互換【運用ブロッカー】
- **現状**: `RULES_PATH` は独自 JSON を `JSON.parse` するのみ（`packages/server/src/cli.ts:48-56`）。
  `service` / `match` / `allow` のトップレベル構文パーサーが存在しない
- **影響**: 本家ルールの二重管理・手動変換が必須。「ローカルで検証したルール ≠ 本番のルール」
  が構造的に発生する

### H-2. `getAfter()` / `existsAfter()` 未実装
- **現状**: グローバル関数は get / exists / debug / 型変換のみ
  （`packages/server/src/security/rules-evaluator/evaluator.ts:264-293`）
- **影響**: 参照整合性ルールが `Unknown function` → 全拒否

### H-3. `list` 評価が実データ依存の per-document 近似（本家は制約からの静的証明）
- **現状**: Phase 1-2 の設計判断（返却集合を評価し 1 件でも拒否なら全体拒否）
- **影響**: ローカルで通るクエリが本番で `permission-denied` になる偽陰性が発生する
  （例: ルールが `resource.data.visibility == 'public'` を要求するとき、制約に visibility を
  含まないが結果がたまたま全件 public のクエリ）。完全一致には制約ベースの静的証明が必要

### H-4. `matches()` が JS RegExp・部分一致（本家は RE2・全体一致）
- **現状**: `new RegExp(pattern).test(str)`
  （`packages/server/src/security/rules-evaluator/string-methods.ts:11-20`）
- **影響**: `'abcdef'.matches('abc')` がローカル true / 本家 false。許可・拒否の両方向でズレる

### H-5. その他のルール言語差分
- `timestamp.time()` 未実装、16 進 / 指数リテラル不可、`{x=**}` が string 束縛（本家 path）、
  `request.auth.token` の標準クレーム（`firebase.sign_in_provider` 等）非自動補完、
  評価時間上限なし、REST `PUT` が既存ドキュメントでも常に `create` 評価
  （`packages/server/src/security/rules-middleware.ts:27-42`）

## I. クライアント SDK の残存差分（2026-07-12 検出、未解決）

### I-1. 一過性エラーで書き込みが確定的に失われる（HTTP リトライなし）【最重要】
- **現状**: transport にリトライ / バックオフ / タイムアウトがなく
  （`packages/client/src/transport.ts:79-141`）、`LocalStore.flush` は送信失敗した mutation を
  キューから除去して reject する（`packages/client/src/local-store.ts:338-363`）。
  自動オフライン検出もない
- **本家**: 書き込みはバックオフ付きで再送され、オフライン中も保持される
- **影響**: 一瞬のネットワーク断や 503 で書き込みが失われる。差し替え運用で最も実害が出やすい

### I-2. オフライン時の `getDoc` / `getDocs` がキャッシュへフォールバックしない
- **現状**: 無条件にサーバーを fetch し、失敗時は生エラー throw（`packages/client/src/crud.ts:38`,
  `query.ts:368-382`）
- **本家**: オフライン時はキャッシュから `fromCache: true` で解決

### I-3. キャッシュ・永続化まわりの API / 挙動差
- ローカルストアは純インメモリで、リロードで保留書き込みも消失（`local-store.ts:104-113`）
- `persistentLocalCache` / `loadBundle` / `setIndexConfiguration` 等が未エクスポート
  （import しているコードはビルド不能）
- `onSnapshot` の `source: 'cache'` は no-op、`terminate()` が以降の操作をブロックしない

### I-4. `SnapshotOptions.serverTimestamps` が無視される
- **現状**: 型はあるが `data(_options)` が参照せず、保留中 serverTimestamp は常にローカル推定値
  （`packages/client/src/types.ts:102-104`, `local-store.ts:273-280`）
- **影響**: デフォルト `'none'`（未確定は null）前提の定石パターンが動かない

### I-5. Transaction / WriteBatch の API 差分
- `set(ref, data, {merge})` オーバーロードなし（`transaction.ts:107-116`, `batch.ts:40-52`）、
  `update(ref, field, value, ...)` 可変長なし、read-after-write がエラーにならない、
  競合リトライにバックオフ遅延なし

### I-6. `FirestoreError` が `FirebaseError` 非互換
- `Error` 直接継承・`name === "FirestoreError"`（`transport.ts:149-157`）。
  `instanceof FirebaseError` 判定が不成立（`err.code` は互換）

## J. 運用・性能・信頼性（2026-07-12 検出、未解決）

### J-1. 書き込み経路が全同期でイベントループを塞ぐ
- **現状**: better-sqlite3 同期 API + 書き込みごとに全購読を線形走査し、影響クエリの SQL を
  フル再実行 + 全件 JSON 差分（`packages/server/src/services/listener-manager.ts:157-173,274-276`）
- **影響**: ホットコレクションへの 1 書き込みが「購読数 × クエリ再実行」の同期コストになり
  全 API レイテンシに直結。差し替え前に想定負荷での実測が必要

### J-2. 過負荷防御が皆無
- WS の接続数上限 / maxPayload / ping-pong / バックプレッシャなし
  （`packages/server/src/websocket.ts:127`, `listener-manager.ts:314,345`）、
  HTTP のレート制限なし
- **影響**: 本家クォータ相当の防御がなく過負荷で自壊。前段プロキシでの制限が事実上必須

### J-3. バックアップ・耐久性
- オンラインバックアップなし（`db.backup()` / checkpoint 呼び出しなし）。`/export` は
  全件メモリ JSON 化でスナップショット一貫性保証なし。`synchronous=NORMAL` 固定で
  電源断時に直近トランザクション群を失う可能性

### J-4. トランザクションのサーバー側セマンティクス差
- トランザクション内クエリなし（単一ドキュメント get のみ競合追跡）、read-your-writes なし、
  有効期限 30 秒固定（本家約 270 秒）（`packages/server/src/services/transaction.ts`）

### J-5. トリガーが at-most-once（本家 Cloud Functions は at-least-once + リトライ）
- ハンドラ失敗は `console.error` のみでリトライ / 永続キューなし
  （`packages/server/src/services/trigger.ts:165-171`）
- **影響**: 再起動・一時障害でイベント恒久ロスト。本家移行時は全面書き直し + べき等化が必要

### J-6. 公式 SDK / 他言語からの接続不可
- プロトコルが完全独自で、firebase-admin / Python / Go / iOS / Android SDK は接続不能
  （docs/2026-07-04-grpc-migration-feasibility.md の設計判断。要件定義の「API互換性」との
  ギャップとして残存）

### J-7. マルチ DB / 認証の運用上の注意
- プロセスロックがベース DB のみ（派生 DB は多重起動ガードなし）、派生 DB の graceful close
  なし、`AUTH_PROVIDER=firebase` のトークン検証失敗が `null`（匿名）に落ちて障害が
  不可視化する（`packages/server/src/security/firebase-auth-provider.ts:34-42`）、
  メトリクスに分位値 / 購読数 / WS 接続数なし

---

# 修正計画

依存関係と影響度から、以下の順で進める。各 Phase は独立して PR 化できる粒度に分割する。
全 Phase 共通: 実装後に該当領域のユニットテスト + `packages/e2e` の E2E テストを追加し、
`pnpm test` / `pnpm lint` を通してからマージする。

## Phase 1: セキュリティルールの本家セマンティクス化（A-1, A-2, A-3）【完了】

**1-1. 評価エンジンの特殊型変換（A-2）** — 他の項目の前提になるため最初に行う
- `rules-evaluator` の値変換層で `{__type: "timestamp" | "bytes" | "geopoint" | "reference"}`
  ラッパーを検出し、ルール型（timestamp / bytes / latlng / path）へ変換してから
  `resource.data` / `request.resource.data` に束縛する
- timestamp メソッド（`toMillis()`, `seconds` 等）・比較演算子・`duration` との演算を
  本家仕様に合わせてテストする
- 対象: `packages/server/src/security/rules-evaluator/`（値変換）、
  `rules-middleware.ts`（束縛前の変換呼び出し）

**1-2. `list` 評価の per-document 化（A-1）**
- 方針: クエリ実行後、返却対象の各ドキュメントについて `resource` を実データで束縛して
  `list` ルールを評価し、**1件でも拒否があればクエリ全体を `permission-denied` にする**
  （本家の「証明できなければ全体拒否」の実用近似。ポストフィルタで黙って間引く方式は
  本家に存在しないため採用しない）
- `request.query`（`limit` / `offset` / `orderBy`）をコンテキストに束縛する
- 空結果のクエリは従来どおりコレクションパスで1回評価する（`resource == null` で評価し、
  エラー時は拒否）
- 集計クエリ（`/aggregate`）はマッチ集合に対して同じ per-document 評価を行う
- `subscribe_query` は初回スナップショットで per-document 評価し、以降の変更通知でも
  追加・変更されるドキュメントごとに評価する。拒否に転じた場合はリスナーへ
  `permission-denied` を送って購読を終了する（本家と同じ挙動）
- 性能: ルールが `resource` / `request.query` を参照しない場合は静的解析で判定して
  1回評価にショートカットする（大量件数クエリの評価コスト対策）
- 対象: `rules-middleware.ts`, `websocket.ts`, `rules-engine.ts`, `context.ts`

**1-3. コレクショングループの実パス評価（A-3）**
- 1-2 の per-document 評価により実ドキュメントパスが得られるため、グループ ID 近似を
  廃止し、`match /{path=**}/xxx/{id}` の再帰ワイルドカードで実パスをマッチさせる

**受け入れ基準**: 本家ドキュメントの「ルールはフィルタではない」節の例
（`resource.data.visibility == 'public'` を条件にした list クエリ等）が本家と同じ
許可 / 拒否結果になる E2E テスト

## Phase 2: リミット強制とバリデーション（B-1〜B-4）【完了】

**2-1. プラットフォームリミット（B-1）**
- 共有パッケージにドキュメントサイズ計算（本家の「ストレージサイズの計算」仕様:
  フィールド名 + 値のバイト数 + ドキュメント名）を実装し、1 MiB 超をエラーにする
- バッチ / トランザクションの 500 オペレーション超をクライアント（早期）と
  サーバー（防御）の両方でエラーにする
- マップ / 配列のネスト深度 20 超、フィールド名制約（`__.*__` 予約名等）をエラーにする
- エラーコードは本家準拠（`invalid-argument`）
- 対象: `packages/shared/`（サイズ計算・深度チェック）、`packages/client/src/batch.ts`,
  `packages/server/src/services/document.ts`, `routes/batch.ts`

**2-2. クエリバリデーション（B-2）**
- `in` / `not-in` / `array-contains-any` の 30 要素制限
- 本家が拒否する組合せ（`array-contains` 複数、`not-in` と `!=` の併用、`not-in` 複数、
  `in` / `not-in` / `array-contains-any` の同時使用制限等）をクライアントで早期エラー +
  サーバーで防御的に検証
- 対象: `packages/client/src/query.ts`, `packages/server/src/services/query.ts`

**2-3. 書き込みバリデーション（B-3）**
- 配列内の FieldValue センチネルをエラーに、`undefined` をデフォルトでエラーにし、
  `FirestoreSettings.ignoreUndefinedProperties` を実装する
- 対象: `packages/client/src/`（シリアライズ層）

**2-4. `deleteField` センチネルのプロトコル表現化（B-4）**
- 文字列 `"$$__DELETE__$$"` をやめ、`{__type: "delete"}` 形式のプロトコル表現に変更する
  （他の `__type` ラッパーと統一）。`serverTimestamp` 等の他センチネルの表現も同時に監査する
- 旧表現のデータ / リクエストの互換読み取りは Phase 3 のマイグレーションと連動

**受け入れ基準**: 本家がエラーにする入力がすべて同一エラーコードで拒否される
ユニットテスト一式

## Phase 3: データ忠実度（C-1〜C-4）【完了】

**3-1. Timestamp のマイクロ秒切り捨て（C-2）** — 単純で影響が局所的なため先行
- 書き込み時にナノ秒をマイクロ秒精度へ切り捨てる。`createTime` / `updateTime` も
  マイクロ秒精度で生成する
- 対象: `packages/shared/`（Timestamp）、サーバーの書き込みパス

**3-2. sum / avg の非数値スキップ（C-3）**
- `firestore_key` の型タグで数値フィールドのみを集計対象に絞る SQL に変更する
- 対象: `packages/server/src/services/query.ts`

**3-3. 数値型の忠実度（C-1）**
- シリアライズ層で整数 / 浮動小数点を区別して保存し（`{__type: "int"}` 相当のタグ付け、
  または保存形式の変更）、`2^53` 超の整数は本家同様の精度挙動に合わせる
- `firestore_key` で NaN を数値の最小としてソートし、`== NaN` フィルタを通す
- 対象: `packages/server/src/storage/firestore-key.ts`, シリアライズ層
- **備考**: 保存形式が変わる場合は 3-4 のマイグレーションに含める

**3-4. 旧形式データのマイグレーション（C-4）**
- `migrate` CLI サブコマンドを追加: SQLite ファイルを走査し、
  (a) 素の `{seconds, nanoseconds}` マップ → `{__type: "timestamp"}`、
  (b) 旧 `"$$__DELETE__$$"` 残存値の検出レポート、
  (c) 3-3 で保存形式が変わった場合の変換、を実行する
- export → import 経路でも同じ変換が効くようにする
- 対象: `packages/server/src/cli.ts`, 新規 `packages/server/src/migration/`

**受け入れ基準**: 特殊値（2^53±1, NaN, Infinity, マイクロ秒未満の Timestamp、文字列混在
フィールドの sum/avg）の round-trip / クエリ結果が本家仕様と一致するテスト

## Phase 4: クライアント体験のパリティ（D-1〜D-3）【完了】

> 設計ドキュメント: docs/2026-07-07-latency-compensation-design.md（2026-07-07 レビュー済み）。
> 実装は同ドキュメントの分割（4a〜4g）に従って進める。
> 進捗: 4a〜4g すべて完了（2026-07-13）。

**4-1. レイテンシ補償（D-1）** — 本計画中で最も設計が重い項目。設計ドキュメントを先に書く
- 方針: `SnapshotCache` を「ローカルビュー」に昇格させる
  1. 書き込み API はサーバー送信と同時に mutation をローカルビューへ適用し、
     該当ドキュメント / クエリのリスナーへ `hasPendingWrites: true` のスナップショットを
     即時発火する（センチネルは本家同様ローカル推定値で解決: `serverTimestamp` は
     クライアント時刻、`increment` はキャッシュ値からの計算）
  2. サーバースナップショット到着時に pending mutation を突き合わせて解消し、
     `hasPendingWrites: false` へ遷移（値が同じでも `includeMetadataChanges` 指定時は
     metadata 変更として通知）
  3. 書き込み失敗時は mutation をロールバックして再スナップショットを発火する
- クエリリスナーへの反映は、キャッシュ上でクエリ制約（フィルタ / orderBy / limit）を
  ローカル評価するマッチャを `packages/shared` に実装して行う（サーバーの比較セマンティクス
  と同一実装を共有する）
- `waitForPendingWrites()` を pending mutation の解消と接続する
- 対象: `packages/client/src/crud.ts`, `listener.ts`, `snapshot-cache.ts`, `batch.ts`,
  `transaction.ts`, `packages/shared/`（クエリマッチャ）

**4-2. キャッシュ読み取り API の配線（D-2）**
- 4-1 のローカルビューを使い `getDocFromCache()` / `getDocsFromCache()` を実装する。
  キャッシュ未命中時は本家同様 `unavailable` エラー
- `fromCache: true` の metadata を返す

**4-3. 再接続時の差分スナップショット（D-3）**
- 再購読で受け取ったフルスナップショットを `SnapshotCache` の直前状態と比較し、
  added / modified / removed の差分 `docChanges()` に変換して通知する
- 切断中に消えたドキュメントが `removed` として届くことをテストする

**受け入れ基準**: 書き込み直後（サーバー応答前）にリスナーが `hasPendingWrites: true` で
発火し、確定後に `false` で再発火する E2E テスト。オフライン → オンライン復帰時の
差分通知テスト

## Phase 5: 運用まわり（E-1, E-2, F）【完了】

**進捗**: 5-1〜5-3 すべて完了（2026-07-11）。Phase 5 完了により全 Phase 完了。

**5-1. 多重起動ガード（E-1）**【完了】
- 起動時に SQLite ファイルと同じディレクトリへロックファイル（PID + タイムスタンプ）を
  作成し、生存プロセスの二重起動をエラーにする。異常終了後の stale ロックは検出して回収
  → `packages/server/src/utils/process-lock.ts`（`acquireProcessLock` / `ProcessLockError`）
- README / architecture ドキュメントへ「1 プロセス = 1 SQLite ファイル」の制約を明記
  → docs/2026-03-15-architecture.md の「前提」に追記
- 対象: `packages/server/src/cli.ts`

**5-2. at-rest 暗号化（E-2）**【完了】
- `better-sqlite3-multiple-ciphers` への差し替え（または DI 済みストレージバックエンドの
  追加実装）で、`DB_ENCRYPTION_KEY` 環境変数指定時に暗号化 DB を開くオプションを提供する
  → `createDatabase(path, { encryptionKey })` で暗号化ドライバへ切り替え。
  マルチデータベース（DatabaseManager）・migrate サブコマンドにも同じ鍵を適用。
  鍵の誤り / 暗号化有無の不一致は起動時に `DatabaseOpenError` で検出
- 既存 DB の暗号化変換は export → import 経路を案内する
  → `DatabaseOpenError` のメッセージと architecture ドキュメントに明記
- 対象: `packages/server/src/storage/`（docs/2026-03-21-storage-backend-di.md の DI 機構を利用）

**5-3. 低優先度の仕上げ（F）**【完了】
- コレクショングループクエリの完全リソース名順の検証テスト + 必要なら `firestore_key` 修正
  → 生パス文字列比較では `"-"` 等（`"/"` より小さい文字）を含む ID で本家のセグメント順と
  食い違うことを確認し、`pathOrderKey`（shared）+ `firestore_path_key` UDF（server）で
  `__name__` の ORDER BY / カーソル比較をセグメント順に修正。query-matcher も同一キーを
  使用（パリティテストで検証）
- `aggregateFieldEqual()` / `aggregateQuerySnapshotEqual()` の実装

## Phase 6: 2026-07-12 再調査分（G〜J）の解消【未着手】

> 詳細と根拠は docs/2026-07-12-firestore-replacement-issues.md を参照。
> 影響度順の推奨着手順。各項目は独立して PR 化できる。

**6-1. クライアント書き込みの再送・オフライン耐性（I-1, I-2）** — データ損失系で最優先
- transport にリトライ / バックオフ / タイムアウトを実装し、`LocalStore.flush` の
  一過性エラー（unavailable / deadline-exceeded 等）を reject でなく再送にする
- `getDoc` / `getDocs` のオフライン時キャッシュフォールバック（`fromCache: true`）

**6-2. serverTimestamp のコミット時刻統一 + 集計の limit / カーソル尊重（G-2, G-3）**
- コミット単位で時刻を 1 回採取して全オペレーションに注入する
- `executeAggregate` を limit / カーソル適用後の集合に対する集計へ変更する

**6-3. ルールの CEL テキスト対応と評価差分（H-1〜H-5）**
- `firestore.rules` テキスト（`service` / `match` / `allow`）のパーサーを追加し
  `RULES_PATH` で両形式を受け付ける（H-1）
- `getAfter()` / `existsAfter()`、`matches()` の全体一致化（可能なら RE2 系エンジン）、
  `timestamp.time()`、`{x=**}` の path 束縛、REST PUT の create / update 判定

**6-4. ID / パス / フィールドパスのバリデーション（G-4, G-5）+ findNearest / documentId()（G-6）**
- 共有バリデータで本家の `invalid-argument` 準拠に統一する

**6-5. クライアント API の残差（I-3〜I-6）**
- `serverTimestamps` オプション、Transaction / WriteBatch の merge オーバーロード、
  read-after-write エラー、`FirestoreError` の `FirebaseError` 互換化、`terminate()` の遮断

**6-6. 運用ハードニング（J-1〜J-7）**
- WS の maxPayload / ping-pong / バックプレッシャ、リスナー再評価の増分化検討、
  オンラインバックアップ（`db.backup()`）、トリガーのリトライ + 永続キュー、
  派生 DB のロック / graceful close、認証検証失敗のログ・メトリクス可視化

**6-7. 文字列の UTF-8 バイト順化（G-1）** — 保存形式（ソートキー）変更を伴うため最後
- `escapeString` / map キー順をコードポイント順へ変更し、migrate に変換を追加する

**受け入れ基準**: 一過性エラー時の書き込み再送 E2E、コミット内 serverTimestamp 一致、
limit 付き集計、本家 `firestore.rules` テキストの読み込み、astral 文字の orderBy が
本家と一致するテスト一式

## 実施順序とマイルストーン

| 順序 | Phase | 理由 |
|---|---|---|
| 1 | Phase 1（ルール）【完了】 | データ漏えい方向の差異を含み最重要。1-1 → 1-2 → 1-3 の順 |
| 2 | Phase 2（リミット）【完了】 | 本番移行時の事故防止。独立性が高く並行着手可 |
| 3 | Phase 3（忠実度）【完了】 | 保存形式の変更を伴うため、マイグレーション（3-4）を最後に一括提供 |
| 4 | Phase 4（レイテンシ補償）【完了】 | 最も工数が大きい。先に設計ドキュメントをレビューしてから着手 |
| 5 | Phase 5（運用）【完了】 | 他 Phase と独立。5-1 は小粒なので隙間で先行実施してよい |
| 6 | Phase 6（2026-07-12 再調査分）【未着手】 | 6-1（書き込み消失）がデータ損失系で最優先。6-7（UTF-8 順）は保存形式変更のため migrate と併せ最後 |

---

## スコープ外（実装しない項目）

以下はクラウドインフラ依存または本家でも非推奨/プレビューのため、実装対象外とする:

- クラウドインフラ依存機能（マルチリージョン、IAM、監査ログ、PITR、BigQuery 連携等）
- 水平スケール（マルチプロセス / マルチインスタンス構成）— ローカル用途のため
  単一プロセス制約を維持し、ガードと明文化（5-1）のみ行う
- 本家 Cloud Functions emulator のトリガープロトコル互換 — 現行の Webhook /
  Node.js API 方式を維持する
- IndexedDB 関連 API（`clearIndexedDbPersistence`, `enableIndexedDbPersistence` 等）— ブラウザ専用機能
- データバンドル（`loadBundle`, `namedQuery`）、パイプラインクエリ — 本家でもプレビュー/低需要
- キャッシュ管理 API（`persistentLocalCache`, `memoryLocalCache` 等）— ブラウザ専用
- SSR/CSR 向け API（`documentSnapshotFromJSON`, `querySnapshotFromJSON`, `onSnapshotResume`）— 特殊用途
- `FieldValue` ベースクラス — 現在の `FieldValueSentinel` アプローチで十分
- 個別の QueryConstraint サブクラス群 — 現在の `QueryConstraint` インターフェースで統一済み
- `offset()` クエリ演算子 — 本家 Web SDK も非提供（Admin SDK 専用）のため Web SDK パリティとして実装しない
- int64 / double のタグ付き区別 — 本家 Web SDK 自体が JS number に透過なため実装しない（C-1 で既決、2026-07-12 再調査でも非差分と確認）
