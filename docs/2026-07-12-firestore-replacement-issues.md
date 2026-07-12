# 本家 Firestore 差し替え運用の課題調査（2026-07-12）

plan.md の Phase 1〜5 完了後のコードベースを対象に、「本家 Firestore（`firebase/firestore`）と
差し替えて運用する」際に問題となる点を再調査した結果をまとめる。
2026-07-04 調査（plan.md 課題一覧 A〜F、すべて解決済み）の後継にあたる。

調査対象: `packages/client` / `packages/server`（security / services / storage / routes）/
`packages/shared` の現行実装。記載のファイルパス・行番号はすべてコードで確認済み。

課題は plan.md の課題一覧に G〜J として登録した。本ドキュメントはその詳細版。

- **G**: データ・クエリ意味論の残存差分
- **H**: セキュリティルールの残存差分
- **I**: クライアント SDK の残存差分
- **J**: 運用・性能・信頼性

---

## 総括: 差し替え時に最初に刺さる順

| # | 課題 | 種別 | 影響 |
|---|------|------|------|
| 1 | 一過性ネットワークエラーで書き込みが確定的に失われる（I-2） | データ損失 | 本家なら再送される書き込みが reject + ロールバック |
| 2 | 本家 `firestore.rules`（CEL テキスト）を読めない（H-1） | 運用ブロッカー | ルールの二重管理・手動変換が必須 |
| 3 | `list` ルール評価が実データ依存の近似（H-3） | セキュリティ / 移行事故 | ローカルで通るクエリが本番で `permission-denied` |
| 4 | serverTimestamp がコミット内で統一されない（G-2) | データ正確性 | 同一コミット内の複数 serverTimestamp が別時刻 |
| 5 | 集計クエリが limit / カーソルを無視（G-3） | データ正確性 | `count(query(coll, limit(10)))` が全件を数える |
| 6 | オフライン時 `getDoc` がキャッシュへフォールバックしない（I-3） | 挙動差 | 本家はキャッシュ返却、ここでは reject |
| 7 | `getAfter()` / `existsAfter()` 未実装（H-2） | ルール互換 | 参照整合性ルールが全拒否になる |
| 8 | 文字列順序が UTF-16 コード単位順（G-1） | クエリ互換 | 絵文字等を含む orderBy / カーソルの順序が本家とズレる |

---

## G. データ・クエリ意味論の残存差分

### G-1. 文字列順序が UTF-16 コード単位順（本家は UTF-8 バイト順）

- **現状**: ソートキーの `escapeString` が `charCodeAt`（UTF-16 コード単位）で走査し
  （`packages/shared/src/firestore-key.ts:41-49`）、map キーの順序も
  `Object.keys().sort()`（UTF-16 順）で決まる。サーバー（`firestore_key` UDF）と
  クライアント（query-matcher）は同一実装で一致するが、本家とはズレる。
- **本家**: 文字列は UTF-8 バイト順（= Unicode コードポイント順）で順序付けられる。
- **影響**: サロゲートペア（U+10000 以上の絵文字等）は UTF-16 では 0xD800〜0xDBFF の
  コード単位で表現されるため、U+E000〜U+FFFF の BMP 文字より**手前**にソートされる。
  UTF-8 順では逆に**後**になる。astral 文字を含むフィールドの orderBy / 範囲フィルタ /
  カーソルページネーションで本家と結果順が食い違う。
- **修正時の注意**: ソートキーのエンコード変更は既存 DB の順序比較全体に波及するため、
  `migrate` サブコマンドとの連動が必要。

### G-2. serverTimestamp がコミット内で単一時刻に統一されない

- **現状**: `createServerMutationContext().serverTimestamp` は呼ばれるたびに
  `new Date()` を読む（`packages/shared/src/mutation-applier.ts:23-36`）。
  バッチ / トランザクションはオペレーションごとに順次適用されるため
  （`packages/server/src/services/transaction.ts:85-110`）、同一コミット内の複数
  serverTimestamp がそれぞれ別時刻に解決される。精度もミリ秒
  （`nanoseconds = (ms % 1000) * 1_000_000`）。
- **本家**: 1 コミットの全 serverTimestamp は単一のコミット時刻に統一される。
- **影響**: 「バッチで N 件に serverTimestamp を書いて同時刻で揃える」「1 ドキュメント内の
  複数 serverTimestamp フィールドが一致する」ことを前提にしたロジックが壊れる。

### G-3. 集計クエリが limit / cursor / orderBy を無視する

- **現状**: `executeAggregate` は WHERE 句のみ構築し、LIMIT / ORDER BY / カーソルを
  SQL に反映しない（`packages/server/src/services/query.ts:194-247`）。
- **本家**: 集計は元クエリの limit / カーソルを尊重した集合に対して行われる。
- **影響**: `getCountFromServer(query(coll, limit(10)))` 等が全一致件数を返す。
  sum / avg も同様に全件対象になる。

### G-4. ドキュメント ID / パスの内容バリデーションが未強制

- **現状**: クライアント `doc()`（`packages/client/src/references.ts:21-27`）と
  サーバー `parseDocumentPath`（`packages/server/src/utils/path.ts`）はセグメント数の
  偶奇のみ検証。ID の 1500 バイト制限、単体 `.` / `..`、空 ID、`__.*__` 予約 ID、
  パス全長 6 KiB の検査がどこにもない（`packages/shared/src/limits.ts` の予約名検査は
  フィールド名のみが対象）。
- **本家**: 上記をすべて `invalid-argument` で拒否する。
- **影響**: ローカルで通っていた ID が本番 Firestore で初めてエラーになる
  （B-1 のドキュメントサイズと同種の移行時事故）。付随して、自動 ID が
  `nanoid`（`-` / `_` を含む 64 文字アルファベット）で本家の `[A-Za-z0-9]` 20 桁と異なる。

### G-5. フィールドパスのバリデーションが本家非準拠

- **現状**: `FieldPath` は空セグメントのみ拒否し、`toString()` は `.` join のみで
  バッククォートエスケープをしない（`packages/client/src/types.ts:200-223`）。
  サーバーの `escapePath` は `^[a-zA-Z0-9_.]+$` 以外を汎用 `Error`
  （`invalid-argument` ではない）で弾く（`packages/server/src/services/query.ts:554-559`）。
- **本家**: 予約文字 `~*/[]` やドットを含むフィールド名はバッククォートでエスケープでき、
  `FieldPath` オブジェクトは任意名を保持できる。
- **影響**: `-` / 空白 / 非 ASCII を含むフィールド名のクエリが非 Firestore エラーで失敗する。
  ドットを名前に含むフィールドはネストとして誤解釈される。

### G-6. findNearest / documentId() のバリデーション・演算子欠落

- **現状**:
  - `findNearest` は queryVector 非空・有限・limit 正整数のみ検証し、limit ≤ 1000、
    ベクトル次元 2048 上限、`distanceMeasure` 値の検証がない
    （`packages/client/src/query.ts:335-343`）。
  - `documentId()`（`__name__`）の where は `==` / `!=` / `in` / `not-in` のみ対応し、
    範囲比較 `<` `<=` `>` `>=` は throw する
    （`packages/server/src/services/query.ts:391-411`、
    `packages/shared/src/query-matcher.ts:84-98`）。
- **本家**: findNearest に上記上限があり、documentId() の範囲フィルタも可能。
- **影響**: 上限超えの findNearest がローカルでだけ通る。documentId() 範囲クエリ
  （シャーディングやパス範囲スキャンの定石）が使えない。

### G-7. 調査済み・非差分として記録する項目

- **int64 / double のタグ付き区別なし**: 有限数は素の JS number として保存され
  （`packages/client/src/serialization.ts:71-80`）、2^53 超整数は精度が落ちる。
  C-1 で「本家 Web SDK 自体が JS number に透過なため実装しない」と既決。
- **`offset()` 非提供**: 本家 Web SDK も `offset()` を持たない（Admin SDK 専用）ため
  Web SDK パリティの範囲内。

---

## H. セキュリティルールの残存差分

### H-1. ルール入力形式が本家 `firestore.rules`（CEL テキスト）と非互換【運用ブロッカー】

- **現状**: `RULES_PATH` は独自 JSON（`SecurityRules` ツリー）を `JSON.parse` で
  読むだけ（`packages/server/src/cli.ts:48-56`）。パーサーは JSON 内の**式文字列**のみを
  解析し、`service` / `match` / `allow` / `rules_version` といったトップレベル構文は
  存在しない（`packages/server/src/security/rules-parser/lexer.ts:48-57`、
  `parser.ts:48-65`）。
- **本家**: `firestore.rules` は CEL 風テキストで、`firebase deploy` / エミュレータ /
  ルール Playground が同一ファイルを扱う。
- **影響**: 本家ルールをそのまま読み込めず、JSON への手動変換・二重管理が必須。
  本番との乖離が構造的に発生し、「ローカルで検証したルール ≠ 本番のルール」になる。
  `rules_version` 宣言も無視される（`{x=**}` は常に v2 相当で固定）。

### H-2. `getAfter()` / `existsAfter()` 未実装

- **現状**: グローバル関数は `get / exists / debug / int / float / string / path / bool`
  のみ（`packages/server/src/security/rules-evaluator/evaluator.ts:264-293`）。
- **本家**: `getAfter()` / `existsAfter()` で書き込み後状態を参照できる
  （バッチ書き込みの参照整合性検証の定石）。
- **影響**: これらを含むルールは `Unknown function` throw → 全拒否。本家で通る書き込みが
  ローカルで一律 `permission-denied` になる。

### H-3. `list` 評価が「実データ依存の per-document 近似」（本家は制約からの静的証明）

- **現状**: 返却対象の各ドキュメントで `resource` を実データ束縛して評価し、
  1 件でも拒否があればクエリ全体を拒否する
  （`packages/server/src/security/rules-engine.ts:196-250`、Phase 1-2 の設計判断）。
- **本家**: クエリの制約（where / orderBy / limit）からルール充足を**静的に証明**
  できなければ、返却データの中身に関係なく拒否する。
- **影響**: **ローカルで通るが本番で拒否されるクエリ**が発生する。例: ルールが
  `resource.data.visibility == 'public'` を要求するとき、`where('title','==','A')`
  （たまたま全件 public）はローカルでは許可されるが、本家は visibility 制約を
  クエリに含まないため拒否する。逆方向（本家で許可・ローカルでデータ次第で拒否）もあり得る。
  ルールを検証環境として使う場合の最大の落とし穴。

### H-4. `matches()` が JS RegExp・部分一致（本家は RE2・全体一致）

- **現状**: `new RegExp(pattern).test(str)`
  （`packages/server/src/security/rules-evaluator/string-methods.ts:11-20`）。
  `replace()` も JS RegExp（同 `:41-51`）。
- **本家**: RE2 方言で文字列**全体**のマッチ。
- **影響**: アンカーなしパターンで判定が逆転する（`'abcdef'.matches('abc')` は
  ローカル true / 本家 false）。RE2 に無い後方参照・ルックアラウンドがローカルでだけ通る。
  許可・拒否の両方向でズレるため、認可バグの温床。

### H-5. その他のルール言語差分

- **`timestamp.time()` メソッド未実装** — `Unknown timestamp method` throw → 拒否
  （`packages/server/src/security/rules-evaluator/timestamp-methods.ts:9-41`）。
- **16 進 / 指数の数値リテラルをパースできない**（`rules-parser/lexer.ts:170-192`）。
- **`{x=**}` の束縛型が string**（本家は path 型）。`is path` 判定で型不一致
  （`rules-engine.ts:341-343`）。
- **`request.auth.token` の標準クレーム非自動補完** — 本家が自動付与する
  `firebase.sign_in_provider` / `firebase.identities` / `email_verified` 等は
  AuthProvider が明示的に含めない限り未定義参照 throw → 拒否
  （`packages/server/src/security/auth-provider.ts:24-38`）。
- **評価のウォールクロック / 複雑度上限なし** — get/exists 10 回・関数スタック深さ 20 は
  あるが、本家の評価時間上限に相当するものがない（偽陽性方向）。
- **REST `PUT /docs/...` が常に `create` として評価される** — 既存ドキュメントへの
  上書き set が本家では `update` ルールで評価されるべきところ `create` で評価される
  （`packages/server/src/security/rules-middleware.ts:27-42`。batch / transaction の
  `set` は既存有無で切替済みなので、REST 直叩き経路のみの不整合）。

---

## I. クライアント SDK の残存差分

### I-1. 一過性エラーで書き込みが確定的に失われる（HTTP リトライなし）【最重要】

- **現状**:
  - HTTP transport にリトライ・バックオフ・タイムアウトが一切ない。`fetch` 1 回で
    `!res.ok` なら即 throw（`packages/client/src/transport.ts:79-141`）。
  - `LocalStore.flush` は送信失敗した mutation を**キューから除去してロールバック**し、
    書き込み Promise を reject する（`packages/client/src/local-store.ts:338-363`）。
  - `navigator.onLine` 等の自動オフライン検出がなく、キュー保持モードに入るには
    `disableNetwork()` の手動呼び出しが必要。
- **本家**: 書き込みはバックオフ付きで再送され、オフライン中も durable に保持される。
- **影響**: 一瞬のネットワーク断・サーバー再起動・503 で、本家なら透過的に再送される
  書き込みが失われる（アプリには reject が返るが、本家準拠のコードは
  「書き込み Promise はオフラインでも解決を待つだけで失敗しない」前提で書かれている
  ことが多い）。差し替え運用で最も実害の出やすい差分。

### I-2. オフライン時の `getDoc` / `getDocs` がキャッシュへフォールバックしない

- **現状**: `getDoc` は無条件に `/docs/...` を fetch し（`packages/client/src/crud.ts:38`）、
  `getDocs` も同様（`packages/client/src/query.ts:368-382`）。失敗時は生エラーが throw され、
  `FirestoreError` にも包まれない。キャッシュ利用は別関数
  （`getDocFromCache` / `getDocsFromCache`）の明示呼び出しが必要。
- **本家**: オフライン時はキャッシュから解決し `fromCache: true` を返す。
- **影響**: オフライン耐性を `getDoc` の暗黙フォールバックに頼っているアプリが
  差し替え後にエラー画面になる。

### I-3. キャッシュ・永続化まわりの API / 挙動差

- **ローカルストアは純インメモリ**（`packages/client/src/local-store.ts:104-113`）。
  ページリロード / プロセス再起動でキャッシュも**未送信の保留書き込みも全消失**する
  （本家は IndexedDB 永続化オプションあり）。
- **永続化系 API が未エクスポート**: `persistentLocalCache` / `memoryLocalCache` /
  `enableIndexedDbPersistence` / `loadBundle` / `namedQuery` / `setIndexConfiguration` 等は
  `packages/client/src/index.ts` に存在しない。これらを import しているコードは
  ビルド時に解決不能になる（plan.md スコープ外扱いだが、差し替え時の書き換え箇所として明記）。
- **`FirestoreSettings` に `localCache` / `cacheSizeBytes` 等のフィールドなし**
  （`packages/client/src/firestore.ts:13-39`）。
- **`onSnapshot` の `source: 'cache'` オプションは no-op**（`listener.ts:649,657`）。
- **`terminate()` がローカルストアを破棄せず、以降の操作もブロックしない**
  （`firestore.ts:257-262`。本家は terminate 後の操作を拒否する）。

### I-4. `SnapshotOptions.serverTimestamps` が無視される

- **現状**: 型（`'estimate' | 'previous' | 'none'`）は存在するが、`data(_options)` は
  引数を参照しない（`packages/client/src/types.ts:102-104`、`snapshots.ts:46-48`）。
  保留中 serverTimestamp は常にローカル推定値（クライアント時刻）で解決される
  （`local-store.ts:273-280`）。
- **本家**: デフォルト `'none'` では未確定 serverTimestamp フィールドは `null`。
  `'previous'` は前回確定値を返す。
- **影響**: 「serverTimestamp が null の間は保留中」という本家の定石パターンが動かない。

### I-5. Transaction / WriteBatch の API 差分

- **`set(ref, data, {merge: true})` オーバーロードなし** — `Transaction.set` /
  `WriteBatch.set` は `(ref, data)` のみ（`packages/client/src/transaction.ts:107-116`、
  `batch.ts:40-52`）。merge 付き set を使うコードは型エラーまたは全上書きになる。
- **`update(ref, field, value, ...)` の可変長オーバーロードなし**（data 形式のみ）。
- **read-after-write がエラーにならない** — 本家 SDK はトランザクション内で書き込み後の
  `get` を実行時エラーにするが、ここでは通る（`transaction.ts:68-91` は都度サーバー呼び出し）。
  ローカルで動いたコードが本家移行時に初めて落ちる方向の差分。
- **競合リトライにバックオフ遅延なし**（`transaction.ts:49-52`、本家はランダム指数バックオフ）。

### I-6. エラーオブジェクトの互換性

- `FirestoreError` は `Error` 直接継承で `name === "FirestoreError"`
  （`packages/client/src/transport.ts:149-157`）。本家は `FirebaseError` 継承で
  `name === "FirebaseError"`。`instanceof FirebaseError` / `err.name` 判定が不成立。
  `err.code` での判定は互換（コード体系は本家の 16 コードと一致）。

---

## J. 運用・性能・信頼性

### J-1. 書き込み経路が全て同期実行でイベントループを塞ぐ

- **現状**: better-sqlite3 の同期 API（`packages/server/src/storage/repository.ts:35-97`）+
  書き込みハンドラ内での同期リスナー再評価（`packages/server/src/app.ts:96-105`）。
  `ListenerManager.notifyChange` は全購読を線形走査し、影響しうるクエリ購読ごとに
  **SQL をフル再実行**して全件 `JSON.stringify` 差分を取る
  （`packages/server/src/services/listener-manager.ts:157-173,274-276`）。
  購読中の全ドキュメントデータをメモリに保持する（同 `:37,113,192`）。
- **影響**: ホットコレクションへの書き込み 1 件が「購読数 × クエリ再実行コスト」の
  同期処理になり、全 API のレイテンシに直結する。バッチはオペレーション数ぶん増幅
  （`routes/batch.ts:34-38`）。本家の Listen バックエンド（増分マッチング）とは
  スケール特性が根本的に異なる。負荷試験なしの差し替えは危険。

### J-2. 過負荷防御が皆無

- WebSocket に接続数上限・`maxPayload`・ハンドシェイク認証・ping/pong 死活監視・
  バックプレッシャ制御（`bufferedAmount` 監視）がない
  （`packages/server/src/websocket.ts:127`、`listener-manager.ts:314,345`）。
- HTTP にレート制限・同時実行制御・ボディサイズ上限（Firestore 仕様の 1 MiB 検証以外）がない。
- **影響**: 本家のクォータ / スロットリングに相当する防御がなく、想定外の負荷で
  サーバー自体がメモリ枯渇 / イベントループ飽和で死ぬ。運用するなら前段のリバース
  プロキシで接続数・レート・ボディサイズを制限するのが事実上必須。

### J-3. バックアップ・耐久性

- オンラインバックアップ手段がない（`db.backup()` / `wal_checkpoint` の呼び出しなし）。
  唯一の経路は `/export`（全件をメモリ上で JSON 化。実行中の書き込みとの
  スナップショット一貫性保証なし。`packages/server/src/routes/data.ts:16-59`）。
- pragma は `journal_mode=WAL` + `synchronous=NORMAL` 固定
  （`packages/server/src/storage/sqlite.ts:50-60`）— 電源断で直近トランザクション群を
  失う可能性がある設定。チェックポイント制御がなく `-wal` ファイルが肥大しうる。
  稼働中のファイルコピーは WAL 併用時に整合性を壊しうる。
- **影響**: 本家の PITR / マネージドバックアップに相当するものがない。
  バックアップ戦略（停止時コピー or 定期 `/export` + 損失許容の明確化）を運用側で
  設計する必要がある。

### J-4. トランザクションのサーバー側セマンティクス差

- OCC はドキュメント version 比較のみ。**トランザクション内クエリが存在せず**
  （`/transaction/get` は単一ドキュメントのみ。`packages/server/src/routes/batch.ts:52-67`）、
  クエリで読んで書くパターンの競合は検出されない。
- read-your-writes なし（`packages/server/src/services/transaction.ts:40-48` はコミット済み
  状態のみ返す）。
- 有効期限 30 秒固定（本家は約 270 秒。`transaction.ts:12-13`）。
- **影響**: 本家 Web SDK の楽観トランザクションと概ね同型だが、上記の範囲で
  検出できない競合・早すぎる `deadline-exceeded` が出る。

### J-5. トリガーが at-most-once（本家 Cloud Functions は at-least-once + リトライ）

- `TriggerService.notifyChange` はハンドラ失敗を `console.error` するだけで
  リトライ・永続キュー・デッドレターがない
  （`packages/server/src/services/trigger.ts:165-171`）。Webhook も `fetch` 1 回。
- **影響**: サーバー再起動・ハンドラ一時障害でイベントが恒久ロストする。重要な副作用
  （集計更新・通知送信）をトリガーに載せる場合は取りこぼし前提の設計（照合バッチ等）が必要。
  本家移行時は Cloud Functions への全面書き直し + at-least-once 前提のべき等化が必要。

### J-6. 公式 SDK / 他言語からの接続不可

- HTTP / WebSocket プロトコルは完全に独自で、Firestore v1 REST / gRPC / WebChannel の
  いずれとも非互換（`docs/2026-07-04-grpc-migration-feasibility.md` の設計判断）。
- **影響**: 接続できるのは `@local-firestore/client`（TypeScript）のみ。
  `firebase-admin`、Python / Go / Java SDK、iOS / Android SDK、既存の運用スクリプトは
  一切接続できない。サーバーサイド処理・データ移行ツールも自前クライアント前提になる。
  要件定義（docs/2026-03-15-requirements.md「API互換性」）とのギャップとして残存。

### J-7. マルチ DB / 認証の運用上の注意

- **プロセスロックがベース DB パスにしか掛からない** — `/databases/:id/*` で遅延生成される
  派生 DB ファイルには多重起動ガードがない（`packages/server/src/cli.ts:159-176` は
  `dbPath` のみロック）。
- 派生 DB の `closeAll` がシャットダウンハンドラから呼ばれない（`cli.ts:162-169` は
  ロック解放のみ）。メトリクスも DB ごとに分断され集約できない。
- **`AUTH_PROVIDER=firebase` でトークン検証失敗が `null`（匿名）に落ちる** —
  検証エラーとトークン無しが区別されず、認証系の障害が「静かに全員匿名」になる
  （`packages/server/src/security/firebase-auth-provider.ts:34-42`）。
  ルールが `request.auth != null` で守られていれば全拒否側に倒れるが、公開読み取りを
  併用する構成では障害に気づけない。
- メトリクスは件数と平均のみでレイテンシ分位・購読数・WS 接続数がない
  （`packages/server/src/middleware/metrics.ts:3-53`）。SLO 監視には不足。

---

## 運用開始前チェックリスト（推奨）

差し替え運用を始める前に、コード修正とは別に運用側で手当てすべき項目:

1. **前段プロキシ**で接続数・レート・リクエストサイズを制限する（J-2）
2. **バックアップ手順**を決める: 定期 `/export`（損失幅 = 実行間隔）または
   プロセス停止を伴うファイルコピー（J-3）
3. **書き込みの再送**をアプリ側で設計する: 書き込み Promise の reject を
   リトライ可能エラーとして扱う（I-1 が解消されるまで）
4. **ルールの二重管理手順**を決める: 本家 `firestore.rules` と JSON の変換責任者・
   レビューフロー（H-1 が解消されるまで）
5. **負荷試験**: 想定購読数 × 書き込みレートで listener 再評価コストを実測する（J-1）
6. **本番 Firestore へ戻す予定があるなら**: G-4（不正 ID）・H-3（list クエリ）・
   I-5（read-after-write）はローカルで通って本番で落ちる方向の差分なので、
   本番相当の検証を別途行う
