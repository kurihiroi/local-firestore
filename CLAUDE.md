# CLAUDE.md

## Git ワークフロー

- mainブランチへの直接pushは禁止。必ずfeatureブランチを切ってPRを作成すること
- PRはCIが通ってからマージする

## 開発手順

### セットアップ

コードを変更・テストする前に、必ず依存関係をインストールしてビルドする:

```bash
pnpm install --frozen-lockfile
pnpm build
```

### テスト実行

テストは必ず `pnpm test` で実行する（CI と同じ方法）:

```bash
pnpm test
```

個別パッケージのテストを実行する場合は、**パッケージディレクトリに移動してから**実行する:

```bash
cd packages/server
npx vitest run src/security/
```

注意:
- プロジェクトルートから `npx vitest run packages/server/...` のように実行しないこと。各パッケージの `vitest.config.ts` が読み込まれず、エイリアス解決に失敗する
- テスト実行前に `pnpm install` と `pnpm build` が完了していることを確認すること

## コーディングルール

- `any` 型の使用は禁止（テストコードを含む）。どうしても必要な場合はユーザーに相談して許可を得ること
