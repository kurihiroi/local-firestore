# レイテンシ補償（楽観的ローカル更新）設計ドキュメント

plan.md Phase 4（D-1 / D-2 / D-3）の設計。実装前レビュー用。

- **D-1**: レイテンシ補償 — 書き込み直後にローカルリスナーへ `hasPendingWrites: true` で即時反映
- **D-2**: キャッシュ読み取り API — `getDocFromCache()` / `getDocsFromCache()`
- **D-3**: 再接続時の差分スナップショット — フル再購読を added / modified / removed の差分に変換

---

## 1. 背景と目的

### 1.1 本家 SDK の挙動（目標セマンティクス）

本家 Firestore Web SDK は書き込み API（`setDoc` / `updateDoc` / `deleteDoc` / `WriteBatch`）の
呼び出し時に、サーバー応答を待たずにローカルのリスナーへ変更を反映する:

1. `setDoc()` を呼ぶと、**サーバー送信と同時に**該当ドキュメント / クエリのリスナーが
   `snapshot.metadata.hasPendingWrites === true` のスナップショットで発火する
2. `serverTimestamp()` 等のセンチネルはローカル推定値で解決される
   （`serverTimestamp` → クライアント時刻、`increment` → キャッシュ値からの計算）
3. サーバーが書き込みを確定してスナップショットが届くと、
   `hasPendingWrites === false` へ遷移する。値が同じ場合、デフォルトのリスナーには
   再通知されず、`includeMetadataChanges: true` を指定したリスナーにのみ
   metadata 変更として通知される
4. 書き込みが失敗（permission-denied 等）した場合、ローカル反映はロールバックされ、
   ロールバック後の状態で再度スナップショットが発火する

### 1.2 現状の問題点

- `setDoc` 等はサーバー往復のみで、`onSnapshot` はサーバーからの WebSocket
  スナップショット到着まで発火しない（`crud.ts` → HTTP、`listener.ts` → WebSocket が独立）
- `SnapshotMetadata`（`hasPendingWrites` / `fromCache`）が**常に `false` 固定**のため、
  metadata に依存するアプリロジックがローカルで検証できない
- `SnapshotCache` は存在するが受信スナップショットを溜めるだけで、
  読み取り API（`getDocFromCache` 等）に接続されていない（D-2）
- 再接続時はフル再購読となり全ドキュメントが `added` として届くため、
  `docChanges()` の変更種別に依存するロジックが誤動作しうる（D-3）

### 1.3 現状アーキテクチャの整理

```
書き込み系:  crud.ts / batch.ts / transaction.ts ──HTTP──▶ サーバー
                     │ （オフライン時のみ）
                     └─▶ WriteQueue（enableNetwork 時に flush）

リスナー系:  listener.ts ──WebSocket(subscribe)──▶ サーバー
                     ▲                                │
                     └──── doc_snapshot / query_snapshot / error
             受信時に SnapshotCache へ保存（読み取りには未使用）
```

書き込みとリスナーが完全に分離しており、両者を接続する「ローカルビュー」が存在しない。
これが Phase 4 で導入する中核コンポーネントである。

---

## 2. 全体設計

### 2.1 コンポーネント構成

`SnapshotCache` を「ローカルビュー」へ昇格させる。新規クラス **`LocalStore`** を
クライアントに導入し、書き込み系とリスナー系の両方がここを経由する。

```
                            ┌───────────────────────────────────────┐
                            │              LocalStore               │
書き込み API ──────────────▶│  MutationQueue（pending mutations）   │
 (crud/batch/transaction)   │       +                               │
                            │  RemoteDocumentCache（サーバー確定値）│
WebSocket スナップショット ▶│       ↓ overlay 合成                  │
 (listener.ts)              │  ローカルビュー（合成済みドキュメント）│
                            └───────────────┬───────────────────────┘
                                            │ 変更イベント
                            ┌───────────────▼───────────────────────┐
                            │        ListenerRegistry               │
                            │  doc リスナー: パス一致で発火          │
                            │  query リスナー: QueryMatcher で       │
                            │  ローカル評価して発火                  │
                            └───────────────────────────────────────┘
```

| コンポーネント | 役割 | 配置 |
|---|---|---|
| `LocalStore` | mutation とリモートキャッシュの管理、ローカルビュー合成、変更イベント発行 | `packages/client/src/local-store.ts`（新規） |
| `MutationQueue` | pending mutation の保持・ack・reject | `LocalStore` 内部 |
| `RemoteDocumentCache` | サーバー確定スナップショットの保持（現 `SnapshotCache` を改修） | `packages/client/src/snapshot-cache.ts` |
| `ListenerRegistry` | リスナー登録と発火（現 `subscriptionCallbacks` を拡張） | `packages/client/src/listener.ts` |
| `QueryMatcher` | クエリ制約（filter / orderBy / limit / cursor）のローカル評価 | `packages/shared/src/query-matcher.ts`（新規） |

`LocalStore` は `Firestore` インスタンスごとに 1 つ（`WeakMap` 管理、既存の
`SnapshotCache` / `WriteQueue` と同じパターン）。

### 2.2 shared クエリマッチャと比較セマンティクスの共有

クエリリスナーへのローカル反映には「このドキュメントはこのクエリにマッチするか」
「結果集合のどの位置に入るか」の判定が必要になる。この比較セマンティクスは
サーバーの `firestore_key`（`packages/server/src/storage/firestore-key.ts`）が
既に実装している Firestore 互換の型順序・値順序と**完全に一致**しなければならない。

**方針: `firestore-key.ts` を `packages/shared/src/firestore-key.ts` へ移動する。**

- サーバーは shared から import する（`packages/server/src/storage/firestore-key.ts` は
  re-export のみ残すか、参照を全て張り替える）
- `Buffer` 依存（`encodeNumber` / bytes の base64 デコード）はブラウザ互換のため
  `DataView` / `atob` ベースへ書き換える（shared は既に `TextEncoder` を使う前例あり）
- shared に `QueryMatcher` を新設し、`valueKey` を使って実装する:

```ts
// packages/shared/src/query-matcher.ts
/** ドキュメントがクエリ制約にマッチするか（filter のみ評価） */
export function matchesQueryFilters(
  data: DocumentData,
  path: string,
  constraints: SerializedQueryConstraint[],
): boolean;

/** クエリ結果集合をローカルで再計算する（filter → orderBy → cursor → limit） */
export function applyQueryConstraints(
  docs: Array<{ path: string; data: DocumentData; createTime: string; updateTime: string }>,
  collectionPath: string,
  collectionGroup: boolean,
  constraints: SerializedQueryConstraint[],
): Array<{ path: string; data: DocumentData; createTime: string; updateTime: string }>;
```

評価対象はワイヤ形式（`__type` ラッパー入り）の `DocumentData`。`valueKey` が
ラッパーを解釈するため、クライアント側でのデシリアライズ前に評価できる。

対応する制約: `where`（全演算子）/ `and` / `or` / `orderBy`（欠損フィールド除外・
`__name__` 暗黙タイブレーク含む）/ `limit` / `limitToLast` / `startAt` 系カーソル。
`findNearest` はローカル評価の対象外とする（ベクトル距離はサーバーでのみ計算し、
findNearest クエリのリスナーはレイテンシ補償なし = 現行挙動を維持）。

サーバーの SQL 実装と shared のマッチャで挙動が乖離しないよう、**同一のテスト
フィクスチャ（クエリ + ドキュメント集合 + 期待結果）を server / shared の両テストから
参照するパリティテスト**を追加する。

---

## 3. 詳細設計（D-1: レイテンシ補償）

### 3.1 Mutation のモデルとライフサイクル

```ts
interface PendingMutation {
  /** 単調増加のローカル ID（適用順序の保証） */
  batchId: number;
  /** 書き込み操作（batch は複数、単発は1件） */
  operations: Array<{
    type: "set" | "update" | "delete";
    path: string;
    data?: DocumentData;      // ワイヤ形式（センチネル含む）
    options?: SetOptions;
  }>;
  /** ローカル推定値の解決に使ったクライアント時刻 */
  localWriteTime: Timestamp;
  state: "pending" | "acknowledged";
  /** acknowledged 後: サーバーが返した updateTime（ISO、マイクロ秒精度） */
  ackedUpdateTimes?: Map<string /* path */, string>;
  /** waitForPendingWrites / 呼び出し元 Promise の解決用 */
  resolve(): void;
  reject(err: FirestoreError): void;
}
```

ライフサイクル:

```
enqueue（書き込み API 呼び出し）
  │  ローカルビュー再計算 → リスナー発火（hasPendingWrites: true）
  ▼
pending ──HTTP 成功──▶ acknowledged ──該当ドキュメントのサーバー
  │                        スナップショット到着（updateTime >= acked）──▶ 除去
  │                                                                        │
  └─HTTP 失敗──▶ 除去（ロールバック）                          ローカルビュー再計算
       │                                                        → 値が同じなら metadata
       ▼                                                          変更のみ通知
   ローカルビュー再計算 → リスナー発火（ロールバック後の状態）
```

- **pending → acknowledged**: HTTP レスポンス成功時。overlay はまだ除去しない
  （WebSocket スナップショットがまだ古い値のことがあるため。除去すると一瞬
  古い値に戻る「フリッカー」が起きる）
- **acknowledged → 除去**: その mutation が書いた全ドキュメントについて、
  `updateTime >= ackedUpdateTime` のサーバースナップショットを観測した時点。
  リスナーが1つも無いドキュメントはサーバースナップショットが届かないため、
  **ack 時点でリスナー未購読のパスの overlay は即座に除去**する（観測者がいないので
  フリッカーも起きない）
- **拒否（HTTP 失敗）**: mutation を除去してローカルビューを再計算し、リスナーへ
  ロールバック後のスナップショットを発火。書き込み API の Promise は reject

### 3.2 プロトコル変更: 書き込みレスポンスに updateTime を含める

acknowledged → 除去の判定に、サーバーが確定した `updateTime` が必要。現在の
書き込みレスポンス（`{success: true}` 等）を拡張する:

```ts
// packages/shared/src/protocol.ts
export interface SetDocumentResponse {
  success: true;
  path: string;
  updateTime: string;   // 追加（マイクロ秒精度 ISO）
  createTime: string;   // 追加
}
// UpdateDocumentResponse / DeleteDocumentResponse / AddDocumentResponse /
// BatchResponse（オペレーションごとの配列）/ TransactionCommitResponse も同様
```

サーバーは `DocumentService` の戻り値（`DocumentMetadata`）を持っているため、
ルートハンドラでレスポンスに含めるだけでよい。後方互換: 旧クライアントは
追加フィールドを無視するだけなので破壊的変更にならない。

### 3.3 センチネルのローカル解決

mutation の `data` はワイヤ形式のまま保持し、**ローカルビュー合成時に**センチネルを
推定値へ解決する（本家と同じ方式。サーバー確定値とローカル推定値を別々に持てる）:

| センチネル | ローカル推定値 |
|---|---|
| `serverTimestamp()` | mutation の `localWriteTime`（クライアント時刻） |
| `increment(n)` | ベース値（下層のローカルビュー値）が数値なら `base + n`、それ以外は `n` |
| `arrayUnion(...)` | ベース配列に深い等値比較で未含有の要素を追加 |
| `arrayRemove(...)` | ベース配列から深い等値比較で一致する要素を除去 |
| `deleteField()` | フィールド削除（`update` / merge `set` のみ。バリデーションは Phase 2 実装済み） |

解決ロジックはサーバーの `DocumentService.resolveFieldValues` /
`deepMerge` / `setFieldByPath`（ドット記法・deep merge・deleteField マーカー処理）と
同一セマンティクスが必要なため、**これらを `packages/shared/src/mutation-applier.ts` へ
抽出して server / client で共有する**:

```ts
// packages/shared/src/mutation-applier.ts
export interface ApplyContext {
  /** serverTimestamp の解決値（サーバー: 現在時刻 / クライアント: localWriteTime） */
  serverTimestamp: () => SerializedTimestamp;
}
export function applySet(base: DocumentData | null, data: DocumentData,
  options: SetOptions | undefined, ctx: ApplyContext): DocumentData;
export function applyUpdate(base: DocumentData, data: DocumentData,
  ctx: ApplyContext): DocumentData;
```

サーバーの `DocumentService` はこの共有実装へ委譲するようリファクタする
（挙動は既存テスト一式で担保）。

### 3.4 ローカルビューの合成

```
localView(path) = MutationQueue を batchId 昇順に applySet/applyUpdate/delete で
                  RemoteDocumentCache(path) へ重ね合わせた結果
```

- ドキュメントの存在状態も overlay の対象（`delete` → exists: false、
  存在しないドキュメントへの `set` → exists: true）
- 合成結果は `Map<path, ComposedDocument>` にキャッシュし、mutation / リモート
  スナップショットの変化時に**影響を受けたパスのみ**再計算する
- `ComposedDocument` は `hasPendingWrites`（そのパスに pending / acknowledged
  mutation が重なっているか）を持つ

```ts
interface ComposedDocument {
  path: string;
  exists: boolean;
  data: DocumentData | null;        // ワイヤ形式
  createTime: string | null;        // ローカル作成時は null（本家同様、確定前は不定）
  updateTime: string | null;
  hasPendingWrites: boolean;
  fromCache: boolean;               // リモート由来のベースが未取得なら true
}
```

### 3.5 リスナーへの即時発火

#### ドキュメントリスナー

`LocalStore` はパス単位の変更イベントを発行する。`listener.ts` の doc リスナーは:

1. 書き込み API が mutation を enqueue → 該当パスの `ComposedDocument` が変化
   → `hasPendingWrites: true` の `DocumentSnapshot` を即時発火
2. サーバースナップショット到着 → `RemoteDocumentCache` 更新 → mutation 突き合わせ
   （3.1）→ 合成結果が変化していればデータ変更として発火。合成結果のデータが
   同一で metadata のみ変化（`hasPendingWrites: true → false`）の場合は、
   `includeMetadataChanges: true` のリスナーにのみ発火

`DocumentSnapshot` / `QueryDocumentSnapshot` / `QuerySnapshot` に `metadata` を
コンストラクタから注入できるようにする（現在は `false, false` 固定のフィールド）。

#### クエリリスナー

クエリリスナーは購読時に「最後にリスナーへ発火した結果集合」（`lastEmittedDocs`）を
保持する。ローカル変更（mutation enqueue / rollback）時:

1. 変更されたパスがクエリの対象範囲（collectionPath / collectionGroup）かを判定
2. 対象なら、`lastEmittedDocs` に変更パスのローカルビューを反映した候補集合を作り、
   shared の `applyQueryConstraints` で filter / orderBy / cursor / limit を再評価
3. 新結果と `lastEmittedDocs` の差分から `docChanges()`（added / modified / removed +
   oldIndex / newIndex）を合成し、`hasPendingWrites: true` で発火

サーバーの `query_snapshot` 到着時は、受信結果に pending mutation の overlay を
重ねてから発火する（overlay が空なら受信結果をそのまま使用 = 現行動作）。

**制約（本家との差異として明記）**: ローカル評価は「クライアントが知っている
ドキュメント」に対してのみ行われる。`limit` 付きクエリでローカル書き込みにより
結果から1件押し出された場合、本来繰り上がるべき「limit 圏外のドキュメント」を
クライアントは持っていないことがあり、次のサーバースナップショットまで結果が
limit 未満になることがある。本家 SDK も同様の制約を持つ（キャッシュにある範囲で補償）。

### 3.6 batch / transaction の扱い

- **WriteBatch**: `commit()` 呼び出し時に全オペレーションを**1つの mutation**として
  enqueue する（アトミックに overlay / rollback される）。`commit()` 前は反映しない（本家同様）
- **Transaction**: 本家 SDK もトランザクションはレイテンシ補償の対象外
  （コミット確定までローカル反映しない）。同じ挙動とし、`runTransaction` は
  現行のサーバー往復のみを維持する。ドキュメントにその旨を明記

### 3.7 オフライン書き込み（WriteQueue）との統合

現在の `WriteQueue`（ネットワーク無効時のキュー）と `MutationQueue` は役割が重なる。
**`MutationQueue` に一本化**する:

- ネットワーク有効時: enqueue → 即時 HTTP 送信（ack で acknowledged へ）
- ネットワーク無効時: enqueue のまま送信を保留し、`enableNetwork()` で順次送信
- どちらの場合もローカルビューへは即時反映される（= オフライン書き込みも
  リスナーに即時反映されるようになり、本家挙動へ近づく）
- `waitForPendingWrites()` は「現時点でキューにある全 mutation が acknowledged
  （または reject）になるまで待つ」に再定義する（現 `WriteQueue.waitForDrain()` を置換。
  本家同様、それ以降に enqueue された書き込みは待たない）

`write-queue.ts` は削除し、`network-state.ts` は enabled フラグ管理のみ残す。

### 3.8 書き込み API の変更（crud.ts / batch.ts）

```ts
// setDoc の新フロー（updateDoc / deleteDoc / addDoc / WriteBatch.commit も同様）
export async function setDoc(ref, data, options?) {
  const dbData = serializeData(...);                    // 現行どおり
  const mutation = localStore.enqueue([{type: "set", path, data: dbData, options}]);
  // ↑ この時点でリスナーへ hasPendingWrites: true が発火する
  return mutation.promise;                              // HTTP ack / reject で解決
}
```

戻りの Promise セマンティクスは現行（サーバー確定で resolve）を維持する。
本家 Web SDK はオフライン時に resolve しない Promise を返すが、これも
`MutationQueue` 一本化により自然に同じ挙動になる（送信保留中は未解決のまま）。

---

## 4. D-2: キャッシュ読み取り API

ローカルビューをそのまま使う:

```ts
export async function getDocFromCache<T>(ref: DocumentReference<T>): Promise<DocumentSnapshot<T>> {
  const composed = localStore.getLocalView(ref.path);
  if (!composed || !composed.hasRemoteBase && !composed.hasPendingWrites) {
    throw new FirestoreError("unavailable",
      "Failed to get document from cache. (However, this document may exist on the server...)");
  }
  // metadata: fromCache: true, hasPendingWrites: 合成結果に従う
}

export async function getDocsFromCache<T>(query: Query<T>): Promise<QuerySnapshot<T>> {
  // RemoteDocumentCache + overlay の全ドキュメントから applyQueryConstraints で評価。
  // キャッシュに対象コレクションのクエリ結果（購読中 or 過去に受信）が無い場合も
  // 空スナップショットではなく「キャッシュにある範囲の結果」を返す（本家同様）。
  // fromCache: true
}
```

- キャッシュ未命中（ドキュメントを一度も観測しておらず pending write もない）は
  本家同様 `unavailable` エラー
- `getDoc` / `getDocs`（サーバー読み取り）も結果を `RemoteDocumentCache` へ書き込み、
  キャッシュを温める（現在はリスナー経由のみ）

## 5. D-3: 再接続時の差分スナップショット

現状: 再接続時にサーバーが初回スナップショット（全件 `added`）を送る。

変更（クライアント側のみで完結、プロトコル変更なし）:

1. クエリリスナーは `lastEmittedDocs`（3.5）を保持している
2. 再接続後の初回 `query_snapshot`（全件 added）を受信したら、`changes` を
   そのまま使わず、**受信 docs と `lastEmittedDocs` を比較して added / modified /
   removed を合成し直す**（サーバーの `ListenerManager.computeChanges` と同じ
   アルゴリズムをクライアントに実装）
3. 切断中に削除されたドキュメントは受信 docs に含まれないため `removed` として通知される
4. doc リスナーは現状でも exists / data 比較で自然に正しいイベントになるため、
   同一データの再通知を抑制する（データ・updateTime が前回発火と同一なら
   metadata 変更扱い）だけでよい

「初回スナップショットか再接続後スナップショットか」の区別は不要で、
**常に `lastEmittedDocs` との差分で changes を作る**方式に統一する
（初回は `lastEmittedDocs` が空なので全件 added となり現行挙動と一致する。
サーバーが送ってくる `changes` フィールドはクライアントでは使用しなくなる）。

---

## 6. 実装分割（PR 粒度）

| # | 内容 | 依存 |
|---|---|---|
| 4a | `firestore-key` の shared 移動（Buffer 除去）+ `QueryMatcher` + server/shared パリティテスト | なし |
| 4b | `mutation-applier` の shared 抽出とサーバーの委譲リファクタ（挙動変更なし） | なし |
| 4c | 書き込みレスポンスへの updateTime / createTime 追加（プロトコル） | なし |
| 4d | `LocalStore` + doc リスナーのレイテンシ補償 + metadata 配線 + `includeMetadataChanges` + `waitForPendingWrites` 再定義 + WriteQueue 統合 | 4b, 4c |
| 4e | クエリリスナーのレイテンシ補償（ローカルクエリ評価） | 4a, 4d |
| 4f | D-2: `getDocFromCache` / `getDocsFromCache` + `getDoc(s)` のキャッシュ書き込み | 4d（4e があれば query も） |
| 4g | D-3: 再接続差分（`lastEmittedDocs` ベースの changes 合成） | 4d |

4a〜4c は挙動に影響しない準備 PR として並行着手できる。

## 7. 受け入れ基準（plan.md より + 詳細化）

- 書き込み直後（サーバー応答前）にリスナーが `hasPendingWrites: true` で発火し、
  確定後に `false` で再発火する E2E テスト
  - doc リスナー / クエリリスナーの両方
  - `includeMetadataChanges` なし: 確定時に値が同じなら再発火しない
  - `includeMetadataChanges: true`: metadata 変更として再発火する
- `serverTimestamp()` がローカル推定値（クライアント時刻）で即時反映され、
  確定後にサーバー時刻へ置き換わる
- `increment()` がキャッシュ値ベースで即時反映される
- ルール拒否される書き込みでローカル反映がロールバックされ、Promise が reject される
- クエリリスナー: フィルタにマッチする書き込みで結果へ即時追加され、
  マッチしなくなる更新で即時除去される（orderBy 位置・oldIndex / newIndex も検証）
- `waitForPendingWrites()` が全 mutation の確定で解決する
- オフライン → オンライン復帰時の差分通知テスト
  （切断中に消えたドキュメントが `removed` として届く）
- `getDocFromCache` / `getDocsFromCache` がローカルビューを返し、
  未命中で `unavailable`、metadata が `fromCache: true` になる
- server / shared クエリ評価のパリティテスト（同一フィクスチャ）

## 8. エッジケース・リスク

- **overlay と同値のサーバースナップショット競合**: ack 前にサーバースナップショット
  （自分の書き込みの反映）が届くケース。updateTime 比較だけでは自分の書き込みか
  判別できないが、「acknowledged 前は overlay を保持し続ける」ルールにより
  表示値は変わらないため実害なし。ack 後に既受信の最新 updateTime と比較して
  除去判定を行う（`RemoteDocumentCache` が最新 updateTime を保持）
- **同一ドキュメントへの連続書き込み**: batchId 順に overlay を重ねるため順序は保たれる。
  途中の mutation だけ失敗した場合、後続 mutation は残して再合成する
  （本家はキュー全体を止めるが、HTTP 単発送信の本実装では独立させる方が単純。
  差異として明記）
- **increment のベース値ずれ**: ローカル推定はキャッシュ基準のため、他クライアントの
  並行書き込みがあると推定値と確定値が異なりうる。確定スナップショットで上書き
  されるため収束する（本家と同じ性質）
- **リスナー未購読ドキュメントへの書き込み**: サーバースナップショットが届かないため
  ack 時に即 overlay 除去（3.1）。`hasPendingWrites: false` への遷移イベントは
  観測者がいないので発火不要
- **メモリ増加**: `RemoteDocumentCache` は購読中 + 読み取り済みドキュメントを保持する。
  ローカル用途では実用上問題にならない想定だが、`terminate()` / `clearCache`
  相当での解放を実装する
- **`firestore-key` 移動のリグレッション**: サーバーのクエリ挙動に直結するため、
  移動 PR（4a）は機械的な移動 + 既存テスト全通過のみとし、書き換え
  （Buffer 除去）にはエンコード結果の互換テスト（移動前後で同一キー）を付ける

## 9. スコープ外

- IndexedDB 等による永続キャッシュ（`persistentLocalCache`）— メモリ内のみ
- トランザクションのレイテンシ補償（本家も非対応）
- `findNearest`（ベクトル検索）クエリのローカル評価
- バンドル / `loadBundle` 系 API（plan.md 全体スコープ外）
- limit 圏外ドキュメントの繰り上がり補償（本家同様、キャッシュにある範囲のみ）
