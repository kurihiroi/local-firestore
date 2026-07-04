# WebSocket を本家互換 gRPC に置き換える検討（2026-07-04）

plan.md（2026-07-04 全面更新版）を踏まえ、現行の独自 WebSocket プロトコルを
本家 Firestore に合わせた gRPC（`google.firestore.v1.Firestore`）へ置き換えられるかを検討した。

## 結論（要約)

- **技術的には可能。ただし「WebSocket → gRPC の置き換え」という単純な話にはならない。**
  本家の実プロトコルを採用するなら、それは「独自クライアント SDK + 独自プロトコル」路線から
  「公式 SDK がそのまま接続できるエミュレータ互換サーバー」路線への**戦略転換**であり、
  トランスポート差し替えではなくプロトコルフロントエンドの新規実装になる。
- **ブラウザでは素の gRPC は使えない**（後述）。本家 Web SDK 自体がブラウザで gRPC を
  使っておらず WebChannel を使っているため、「gRPC にすればブラウザも本家と同じになる」
  わけではない点が最大の注意点。
- 採用するなら段階導入（案C）を推奨。**判断のデッドラインは plan.md Phase 4（レイテンシ補償）
  着手前**。本家プロトコル化すると Phase 4 の成果物（D-1〜D-3）は公式 SDK のクライアント側
  機能で置き換えられ、実装工数が丸ごと捨てられるため、両方をやるのは二重投資になる。

---

## 1. 前提整理: 本家のトランスポートは環境ごとに異なる

「本家に合わせる」前に、本家 SDK が実際に何を話しているかの整理が必要。

| 環境 | SDK | トランスポート |
|---|---|---|
| Node / サーバー | `firebase-admin` / `@google-cloud/firestore` | ネイティブ gRPC（`@grpc/grpc-js`、HTTP/2）。unary は REST(JSON) fallback あり（`preferRest`） |
| Node | `firebase/firestore`（JS SDK を Node で使用） | ネイティブ gRPC |
| **ブラウザ** | `firebase/firestore`（Web Modular SDK） | **gRPC ではない**。unary RPC は `POST /v1/...:runQuery` 形式の JSON（proto の JSON エンコーディング）、`Listen` / `Write` ストリームは **WebChannel**（`/google.firestore.v1.Firestore/Listen/channel` 等） |

ブラウザで素の gRPC が使えない理由:

- ネイティブ gRPC は HTTP/2 のフレーミングと trailers に依存し、ブラウザの
  fetch / XHR からは制御できない
- 代替の **gRPC-Web は server-streaming までしか対応せず、双方向ストリーミング非対応**。
  Firestore の `Listen` / `Write` は bidi ストリームなので gRPC-Web では実装できない。
  本家が WebChannel（Google 独自の双方向 HTTP プロトコル）を使っているのはこのため

公式 Firestore エミュレータは「gRPC + REST(JSON) + WebChannel」の 3 面すべてを実装しており、
だからこそ firebase-admin（gRPC）も Web SDK（REST+WebChannel）も同じエミュレータに接続できる。

このプロジェクトの現行構成（`fetch` + グローバル `WebSocket` のみに依存する
`packages/client`、`docs/2026-03-15-architecture.md` の前提どおりブラウザ動作可能）に対して、
「本家に合わせる」の意味を次の 3 案に分解して評価する。

---

## 2. 案の比較

### 案A: 独自クライアントを維持し、内部トランスポートだけ WS → gRPC に差し替える

- **評価: 非推奨（実質不成立）**
- リスナー（bidi 相当）はブラウザで gRPC / gRPC-Web では実現できないため、
  ブラウザ対応を捨てるか Envoy 等のプロキシを挟むかの二択になる
- プロトコルの中身は独自のままなので**本家互換性は 1mm も向上しない**。
  plan.md の課題（A〜F）はどれも解消されず、失うもの（ブラウザの手軽さ、
  依存ゼロのクライアント）だけがある
- 「gRPC にする」こと自体が目的化した案であり、やる理由がない

### 案B: サーバーに本家 `google.firestore.v1` プロトコルを実装する（エミュレータ互換）

- **評価: 目指すならこれが最終形。ただし工数は大**
- サーバーが公式プロトコルを話せれば、**公式 SDK（firebase-admin /
  `@google-cloud/firestore` / `firebase/firestore` + `connectFirestoreEmulator()` /
  `FIRESTORE_EMULATOR_HOST`）がそのまま接続できる**。既存の
  `connectFirestoreEmulator()` シム（plan.md 済み項目）が本物になるイメージ
- 独自 `packages/client` は不要化への道に乗る（互換シムとして残すことは可能）
- 完全対応にはブラウザ向け WebChannel サーバー実装が必要（後述のとおり最難関）

### 案C: 段階導入（案B を 3 段階に分割し、WS/HTTP は並存させる）

- **評価: 推奨。** 各段階が単独で価値を出す
- **C-1: gRPC unary + server-streaming**（`GetDocument` / `BatchGetDocuments` /
  `RunQuery` / `RunAggregationQuery` / `Commit` / `BatchWrite` /
  `BeginTransaction` / `Rollback` / `ListCollectionIds`）
  → **firebase-admin と `@google-cloud/firestore` が動くようになる**（admin SDK は
  リアルタイムリスナー以外を unary で完結できる）。運用スクリプト・シード投入・
  サーバーサイドコードが公式 SDK のまま local-firestore に向けられる
- **C-2: `Listen` / `Write` bidi ストリーム**
  → Node 上の `firebase/firestore`・admin SDK の `onSnapshot` が動く
- **C-3: REST(JSON) unary + WebChannel**
  → ブラウザの Web SDK が動く。ここまで来たら独自クライアントを deprecate 可能。
  なお REST(JSON) unary は Hono ルートとして実装できるため難度は低く、
  難しいのは WebChannel のみ
- 既存の WS + 独自 HTTP API は各段階で並存させ、独自クライアント利用者を壊さない

---

## 3. 案B/C の実装内容と難度

### 3-1. proto 値変換層（難度: 中、ただし plan.md Phase 3 が前提になる）

proto の `Value`（`nullValue` / `booleanValue` / `integerValue`(int64) / `doubleValue` /
`timestampValue` / `stringValue` / `bytesValue` / `referenceValue` / `geoPointValue` /
`arrayValue` / `mapValue`）と内部の `__type` ラッパー JSON の相互変換。

- **plan.md C-1（int64 / double の区別）が「あると良い」から「必須の前提」に昇格する**。
  proto では整数と浮動小数点が別フィールドであり、区別せずには本家 SDK と round-trip
  できない
- 同様に C-2（Timestamp マイクロ秒精度）、`createTime` / `updateTime` の proto
  Timestamp 化も前提になる
- ドキュメント名は `projects/{projectId}/databases/{databaseId}/documents/{path}` の
  完全リソース名。現行のマルチデータベース（`databaseId`)に加えて `projectId` の概念が
  必要（エミュレータ同様、任意の projectId を受け入れる形でよい）
- `referenceValue` も完全リソース名になるため、`{__type: "reference"}` の格納形式との
  変換が要る

### 3-2. unary / server-streaming RPC（難度: 中）

既存の service 層（document / query / transaction）はそのまま使え、ルート層の追加のみ。

- `StructuredQuery` proto ↔ 既存 `SerializedQueryConstraint` のマッピング
  （フィルタ・orderBy・カーソル・limit/offset は概念がほぼ 1:1）
- `Commit` の `Write`（update / delete / transform / `updateMask` /
  `currentDocument` precondition）→ 既存 batch オペレーションへの変換。
  `DocumentTransform`（`setToServerValue` / `increment` / `appendMissingElements` /
  `removeAllFromArray`）は既存の FieldValue センチネル解決と対応が取れる。
  **plan.md B-4（`deleteField` センチネルのプロトコル表現化）はここで自然に解消**
  （proto では `updateMask` で表現されるため文字列センチネル自体が消える）
- トランザクション: 本家プロトコルは `BeginTransaction` → 読み取りに transaction ID を
  添付 → `Commit(transaction)`。現行の transactionId + OCC 方式と構造が同じで移植可能
- サーバー実装は `@grpc/grpc-js` + `@grpc/proto-loader`（proto 定義は googleapis から
  vendoring）。Hono(HTTP/1.1) と gRPC(HTTP/2) の同居は、初期は**別ポート**が現実的
  （公式エミュレータは同一ポートだが、h2c の振り分け実装が必要になるため後回しでよい。
  `@connectrpc/connect-node` で gRPC プロトコルを Node の http2 サーバーに載せ、
  1 プロセス内で共存させる選択肢もある）

### 3-3. `Listen` ストリーム（難度: 大 — 本体）

公式 SDK の `onSnapshot` を支えるプロトコルで、独自 WS プロトコルより大幅にリッチ:

- `ListenRequest`: `addTarget` / `removeTarget`、target は query / documents の 2 種、
  `resumeToken` / `readTime` による再開
- `ListenResponse`: `targetChange`（`ADD` / `REMOVE` / `CURRENT` / `RESET` /
  `NO_CHANGE`）、`documentChange` / `documentDelete` / `documentRemove`、
  `filter`（existence filter）
- 公式 SDK は `CURRENT` + resume token 付き `NO_CHANGE` で「スナップショットが
  一貫した状態に達した」ことを判定してから onSnapshot を発火する。この
  **グローバルスナップショット / resume token のセマンティクス**を正しく実装しないと
  公式 SDK は永久に待つ・二重発火する等の不具合になる
- 現行 `ListenerManager` の「コミット後に変更ドキュメントを購読へ配信」という設計は
  流用できるが、target 管理・resume token（単調増加のバージョン番号で可。SQLite の
  グローバル書き込みカウンタを resume token にするのが素直）・切断再開時の差分配信を
  新規実装する必要がある。**これは plan.md D-3（再接続時の差分スナップショット）の
  サーバー側解決版**でもある
- existence filter は「定期的にターゲット内のドキュメント数を送る」機能で、
  エミュレータ相当なら最小実装（または送らない）でも SDK は動くが、検証が必要

### 3-4. `Write` ストリーム（難度: 中〜大）

Web SDK（および Node の firebase/firestore）は書き込みを unary `Commit` ではなく
`Write` bidi ストリームで送る（ハンドシェイク → `streamToken` 付き書き込み →
`WriteResponse`）。admin SDK だけが対象なら不要だが、C-2 以降では必須。
ストリームトークンの管理を除けば中身は `Commit` と同じで、既存 batch 実装に載る。

### 3-5. WebChannel サーバー（難度: 大 — 最難関）

ブラウザ Web SDK 対応（C-3）にのみ必要。

- WebChannel は Google closure library 由来の独自プロトコルで、公開仕様が薄く、
  サーバー側 OSS 実装がほぼない（公式エミュレータ(Java)が事実上のリファレンス）
- long-polling とストリーミングの 2 モード、セッション管理、SID/AID の再送制御など
  地味に重い
- ここだけは「実装しない」判断もあり得る: その場合ブラウザは独自クライアント
  （現行 WS）を使い続け、Node/サーバーサイドのみ公式 SDK 対応とする構成になる

### 3-6. セキュリティルール・認証の統合(難度: 中)

- 公式エミュレータ同様、`Authorization: Bearer <ID トークン>` メタデータで認証し
  ルール評価、`Bearer owner`（および admin SDK からの接続）はルールバイパス、
  `mockUserToken` 対応 — 既存の `AuthProvider` / `SecurityRulesEngine` /
  rules-middleware がそのまま使える
- **plan.md A-1（`list` の per-document 評価）はどのみち必要**で、実装先が
  rules-middleware + websocket.ts から RunQuery / Listen ハンドラに変わるだけ

---

## 4. plan.md への影響（ここが判断の核心）

| plan.md 項目 | 本家プロトコル化（案B/C）した場合 |
|---|---|
| Phase 1（A-1〜A-3 ルール） | **変わらず必要**。実装レイヤーが gRPC ハンドラに移るだけ。先行してよい |
| Phase 2（B-1 リミット、B-2/B-3 のサーバー側） | **変わらず必要** |
| B-2 / B-3 のクライアント側早期エラー | **不要化**（公式 SDK が本家そのもののバリデーションを持つ） |
| B-4（deleteField センチネル） | **プロトコル移行で自然解消**（proto は updateMask で表現） |
| Phase 3（C-1 int64/double、C-2 µs） | **前提条件に昇格**。gRPC 化の前に完了が必須 |
| Phase 4（D-1 レイテンシ補償、D-2 キャッシュ API、D-3 再接続差分） | **丸ごと不要化**。公式 SDK のローカルミューテーションキュー・キャッシュ・`hasPendingWrites` がそのまま動く。plan.md 自身が「本計画中で最も設計が重い項目」と評価している工数が消える |
| Phase 5（E-1 多重起動ガード、E-2 暗号化） | 変わらず必要（gRPC 化と独立） |

つまり:

- **共通資産**: Phase 1・2（サーバー側）・3・5 → どちらの路線でも無駄にならない
- **排他投資**: Phase 4（独自クライアントのレイテンシ補償）⇔ gRPC/Listen 実装
  → 両方やると二重投資。**Phase 4 着手前にどちらの路線か決めるべき**

工数の定性比較: Phase 4（D-1〜D-3）は独自クライアント内に本家 SDK のローカルビュー相当を
再実装するもので、これ自体がかなり大きい。案C の C-1（unary gRPC）は既存 service 層の
薄いフロントエンド追加であり Phase 4 より小さく、C-2（Listen/Write）は Phase 4 と
同等以上、C-3（WebChannel）はさらに大きい。ただし案C 側は段階ごとに
「公式 SDK が使える」という互換性リターンがあるのに対し、Phase 4 のリターンは
独自クライアントの体感改善に留まる。

---

## 5. リスク・制約

- **Listen セマンティクスの再現度**: 公式 SDK はプロトコルの細部（CURRENT、
  resume token、ターゲット状態機械）に依存しており、雑な実装だとハング・二重通知など
  デバッグ困難な不具合になる。公式 SDK を実クライアントにした E2E テスト
  （`packages/e2e` に firebase / firebase-admin を devDependency 追加）を最初から
  用意して進めるのが必須
- **proto 依存の追加**: サーバーに `@grpc/grpc-js` + proto 定義が入る。
  クライアント側は公式 SDK を使うので依存ゼロ方針への影響なし
- **単一プロセス制約（E-1）**: gRPC 化しても変わらない（トランスポートの話であり
  ストレージ/リスナー基盤は同一）
- **WebChannel**: リファレンス実装が乏しく、ブラウザ対応の到達可能性が最も不確実。
  「ブラウザは独自クライアント継続、Node は公式 SDK」というハイブリッド終着点も
  許容できるかをあらかじめ決めておくとよい
- **旧データ**: proto 化に伴う保存形式変更（int64 タグ付け等）は plan.md 3-4 の
  マイグレーションに統合する

---

## 6. 推奨

1. **案A（単純置換）はやらない**。ブラウザで bidi gRPC は不可能で、互換性メリットもない
2. 本家互換（＝本番 Firestore との置き換え可能性）がプロジェクトのゴールである以上、
   **中期的には案C（段階的な本家プロトコル実装）を推奨**
3. 進め方:
   - Phase 1（ルール）→ Phase 3（C-1/C-2 データ忠実度）を先に完了させる
     （どちらも gRPC 化の前提・共通資産）
   - その後 **Phase 4 の代わりに C-1（unary gRPC = admin SDK 対応）から着手**し、
     公式 SDK E2E を整備しつつ C-2（Listen/Write）へ進む
   - C-3（WebChannel）は C-2 完了後に投資判断（ブラウザ要件の強さ次第で見送り可）
   - 独自クライアント + WS は当面並存させ、公式 SDK 経路が安定した時点で
     deprecation を判断する
4. plan.md の Phase 4 は「案C を採らない場合のみ実施」の条件付き項目に格下げする
