# リアルタイムトランスポート（WebSocket）の扱いに関する検討と結論（2026-07-04）

「WebSocket ではなく本家に合わせた gRPC にすることは可能か」という問いから始めた検討の
結論と、その過程で整理した論点をまとめる。

## 結論

**WebSocket は現状維持とする。gRPC / WebChannel への置き換えは行わない。**

理由:

1. **このプロジェクトのゴールにワイヤプロトコルは関係ない。**
   ゴールは「公式 SDK（`firebase/firestore`）を自前実装（`@local-firestore/client`）に
   import 差し替えして既存アプリを動かす」ことである。アプリコードから見えるのは
   クライアント SDK の API とセマンティクスだけで、SDK とサーバーの間で何を話しているか
   （WebSocket か gRPC か）はアプリから不可視。トランスポートを本家に合わせても
   差し替え互換性は 1 項目も改善しない
2. **そもそも本家もブラウザでは gRPC を使っていない。**
   本家 Web SDK のトランスポートは「JSON の POST リクエスト（unary RPC）+
   WebChannel（Listen / Write ストリーム）」であり、ネイティブ gRPC を話すのは
   Node 系 SDK（firebase-admin 等）だけ。ブラウザはネイティブ gRPC を話せず
   （HTTP/2 trailers を fetch/XHR から制御できない）、gRPC-Web も双方向ストリーミング
   非対応のため Listen を載せられない
3. **WebChannel が WebSocket に勝るのは「制限の厳しいネットワークでも通る」点のみ。**
   本プロジェクトの利用環境は WebSocket が通る前提でよいと判断したため、
   この利点に価値がない

| 接続元 | 本家のトランスポート |
|---|---|
| ブラウザ（firebase/firestore） | JSON POST（unary）+ WebChannel（ストリーム）。すべて HTTPS 上 |
| Node（firebase-admin, @google-cloud/firestore） | ネイティブ gRPC（HTTP/2） |
| 公式エミュレータ | 上記両方 + REST を受け付ける |

## 論点の整理: gRPC 化が効くのは「逆方向」の互換性だけ

「本家に合わせた gRPC（`google.firestore.v1`）をサーバーに実装する」ことに意味があるのは、
**公式 SDK をクライアントとしてこのサーバーに接続させたい場合**（公式エミュレータの
代替になる場合）だけである。それは本プロジェクトのゴール（公式 SDK を自前実装に
差し替える）とは逆方向の互換性であり、採用しない。

将来 firebase-admin などサーバーサイドの公式 SDK をこのサーバーに向けたくなった場合のみ、
unary 系 RPC（`RunQuery` / `Commit` / `BatchGetDocuments` 等）の gRPC 実装を
追加する選択肢がある（admin SDK はリスナー以外を unary で完結できるため、
最難関の `Listen` bidi ストリームと WebChannel を実装せずに済む）。必要になった時点で
再検討する。

## 公式 SDK → 自前実装の差し替えに必要な修正点

差し替えで問題になるのはトランスポートではなく**セマンティクスの差**であり、
その全体リストは plan.md の課題一覧（A〜F）と修正計画（Phase 1〜5）である。
本検討で新たに追加すべき項目は見つからなかった。WebSocket / 独自プロトコル自体に
起因する非互換は存在しない。

リアルタイムリスナー（WebSocket 経路）に関わる修正点は、いずれもプロトコルではなく
サーバー / クライアントのロジック修正で解決するもので、plan.md に収録済み:

| plan.md | 内容 | 修正レイヤー |
|---|---|---|
| A-1 | `subscribe_query` の `list` ルール評価が per-document になっていない（データ漏えい方向のズレ。最優先） | サーバー `websocket.ts` / rules-middleware |
| D-1 | レイテンシ補償がなく、`SnapshotMetadata`（`hasPendingWrites` / `fromCache`）が常に `false` 固定 | クライアント `crud.ts` / `listener.ts` / `snapshot-cache.ts` |
| D-2 | `getDocFromCache()` / `getDocsFromCache()` が未配線 | クライアント |
| D-3 | 再接続時にフル再購読となり全ドキュメントが `added` として届く | クライアント（`SnapshotCache` との差分合成） |

リスナー以外の修正点（ルールの特殊型対応 A-2 / コレクショングループ A-3、
ハードリミット B、データ忠実度 C、運用 E、低優先度 F）も同様に plan.md を正とする。

## 本検討による plan.md への影響

なし。現行アーキテクチャ（独自クライアント + HTTP/JSON + WebSocket）のまま、
plan.md の Phase 1 → 2 → 3 → 4 → 5 を予定どおり進める。
