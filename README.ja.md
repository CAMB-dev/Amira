# Amira

[English](README.md) · [简体中文](README.zh-CN.md)

Amira は、TypeScript と Bun で構築された、端末向けの軽量で拡張可能なコーディングエージェントです。プロジェクトのファイルを読み書きし、ツールを実行し、サブエージェントにタスクを委任します。モデルのプロバイダーを自分で選び、対話型モード、print モード、RPC モードで利用できます。

> 開発中です。

## インストール

次のいずれかのパッケージマネージャーで、ビルド済みの実行ファイルをインストールしてください（npm/pnpm のランチャーには Node.js 18 以降が必要です。Bun は不要です）。

```sh
npm i -g amira
pnpm add -g amira
bun add -g amira
```

または、[GitHub Releases](https://github.com/CAMB-dev/Amira/releases) からアーカイブをダウンロードしてください。対応プラットフォーム、チェックサム、署名付きマニフェスト、更新コマンドについては、[インストールと検証](docs/ja/install.md)を参照してください。

### ソースからのインストール

[Bun](https://bun.sh) をインストールし、このリポジトリをチェックアウトしたディレクトリで次のコマンドを実行してください。

```sh
bun install
cd packages/cli
bun link
cd ../..
```

CLI パッケージはグローバルな `amira` コマンドを提供します。Bun の実行ファイルがあるディレクトリを PATH に追加してください。リポジトリのルートから `bun run amira` を実行することもできます。

ナイトリー版の実行ファイルは、プレリリースとして [GitHub Releases](https://github.com/CAMB-dev/Amira/releases) で入手できます。ローカルでのビルドと診断については、[Amira のビルド](docs/ja/building.md)を参照してください。

## 初回の起動

対話型 UI は常に全画面で動作し、終了時に会話を通常画面へ出力します。プレーンな出力には `amira -p "<prompt>"` を使ってください。

プロジェクト内で `amira` を実行してください。`/provider add` でプロバイダーを追加し、models.dev カタログからベンダーを名前または ID で検索して、事前入力された設定、モデル、キーの取得元を確認します。ローカルサービスや一覧にないサービスを使う場合、またはオフラインでカタログを利用できない場合は、`Custom` を選び、プロトコルとベース URL を手動で選択してください。組み込みのプロトコルは `openai-chat`、`openai-responses`、`anthropic-messages`、`google-gemini` です。環境変数からキーを取得する場合は、`Environment variable` を選択し、変数名（`apiKeyEnv`）を入力して、Amira を起動するシェルでその変数を設定してください。その後、`/model` でモデルを選びます。設定の詳細については、[プロバイダー](docs/ja/providers.md)を参照してください。

リクエストを入力して Enter を押してください。デフォルトでは、ターンの実行中に Enter を押すと追加の指示を送り、Alt+Enter を押すと次のターン用のメッセージをキューに追加します（Windows では Ctrl+Q を使う場合があります。ヒント行を確認してください）。Esc で中断します。待機中のメッセージがあれば、すぐに送信されます。Esc を 2 回押すと、保存済みセッションの巻き戻し画面が開きます。巻き戻しで変更されるのは会話であり、ファイルではありません。`@` でファイルパスを選択し、`$` でスキルを選択し、`/` でコマンドを参照できます。入力欄が空の状態で `?` を入力すると、キー操作を確認できます。`/ext` で拡張機能の参照、インストール、管理ができます。`/provider` はプロバイダー管理ページを開き、Enter で編集、キー設定、接続テスト、削除を選べます。Esc で閉じます。モデルの複数選択一覧は入力で絞り込み、Ctrl+A でフィルターに一致する項目をすべて選択または解除し、Ctrl+X で選択を反転できます。

## ドキュメント

- [はじめに](docs/ja/getting-started.md)
- [プロバイダーと API キー](docs/ja/providers.md)
- [日常の使い方、セッション、自動化](docs/ja/usage.md)
- [サブエージェントと worktree](docs/ja/subagents.md)
- [拡張機能の使い方と作成方法](docs/ja/extensions.md)
- [キー割り当て](docs/ja/keybindings.md)
- [テーマ](docs/ja/themes.md)
- [設定リファレンス](docs/ja/settings.md)

## ライセンス

Apache License 2.0 です。[LICENSE](LICENSE) と [NOTICE](NOTICE) を参照してください。Amira または Amira を基にした製品を配布する場合は、NOTICE ファイルも同梱してください。
