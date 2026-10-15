# Amira のビルド

[English](../building.md) · [简体中文](../zh/building.md) · [ドキュメント](../../README.ja.md)

このリポジトリをチェックアウトしたディレクトリで、Bun **1.4.2** を使ってください。

```sh
bun install --frozen-lockfile
bun run build                       # Current platform and architecture
bun run build --target bun-windows-x64
bun run build:all                   # All seven targets
bun run build:all --version 0.1.0-nightly.20261011 --channel next
```

デフォルトのバージョンは `packages/cli/package.json` から取得します。`--version` で上書きできます。デフォルトのチャネルは `stable` です。`--channel stable|next` で上書きできます。Bun は 1 台のマシンですべてのターゲットをクロスコンパイルでき、必要に応じて対応する Bun ランタイムをダウンロードします。

| ターゲット | アーカイブ |
| --- | --- |
| `bun-windows-x64` | `.zip` |
| `bun-windows-x64-baseline` | `.zip` |
| `bun-linux-x64` | `.tar.gz` |
| `bun-linux-x64-baseline` | `.tar.gz` |
| `bun-linux-arm64` | `.tar.gz` |
| `bun-darwin-x64` | `.tar.gz` |
| `bun-darwin-arm64` | `.tar.gz` |

x64 の baseline ターゲットは、AVX2 をサポートしない古い CPU に対応しています。実行ファイルは `dist/amira-<target>/amira`（Windows では `amira.exe`）に出力され、アーカイブは `dist/amira-<target>.zip` または `.tar.gz` に出力されます。`dist/SHA256SUMS` には、アーカイブの SHA-256 チェックサムが含まれます。`dist/` は Git の管理対象外です。

単一ファイルの実行ファイルには、Bun ランタイム、組み込みアセット、Worker のエントリーポイントが含まれます。実行するために Bun をインストールする必要はありません。外部の TypeScript 拡張機能には対応していますが、コンパイル済みの実行ファイルでは JSX 拡張機能に対応していません。

## ビルドの確認

実行ファイルの OS とアーキテクチャに一致するマシンで、次のコマンドを実行してください。

```sh
./dist/amira-bun-linux-x64/amira --version
./dist/amira-bun-linux-x64/amira --self-check
```

Windows では、`dist/amira-bun-windows-x64/amira.exe` を使ってください。`--version` は、バージョン、チャネル、ターゲットを表示します。非公開のオプション `--self-check` は JSON を出力し、Worker が `ready` を送信しなかった場合（インラインフォールバックを含みます）、組み込みテーマを読み取れない場合、または Windows Job Objects を利用できない場合に、ゼロ以外の終了コードで終了します。プロバイダーの認証情報は不要で、実際の API にアクセスすることもありません。

## CI とナイトリー版

CI は `main` への push とプルリクエストで実行され、Ubuntu、Windows、macOS 上で Bun 1.4.2 を使います。各ランナーは固定されたロックファイルに従って依存関係をインストールし、`bun run check`（アーキテクチャ、型、lint、テスト）を実行してから、その環境向けの実行ファイルをビルドし、スモークテストを行います。テストにはリポジトリの隔離されたテスト用ホームディレクトリを使います。実際のサービスに接続するテストのオプトインは有効にしません。

ナイトリー版のワークフローは、毎日 **18:00 UTC** に実行されます。GitHub Actions から手動で実行することもできます。`main` を確認し、前回のナイトリー版以降にコミットがなければスキップします。3 つのプラットフォームすべてが同じチェックに合格した後、1 つのランナーがチャネル `next` 用に 7 つすべてのターゲットをクロスコンパイルします。別のネイティブランナーがアーカイブのチェックサムを検証し、アーカイブを展開して、Bun をインストールせずに Windows x64、Linux x64（どちらも baseline を含みます）、macOS ARM64 のスモークテストを行います。`macos-13` は 2025 年 12 月に廃止されたため、macOS x64 のスモークテストはスキップします。Linux ARM64 には、現在ネイティブのスモークテスト用ランナーがありません。

ナイトリー版は [GitHub Releases](https://github.com/CAMB-dev/Amira/releases) からダウンロードできます。`v<X.Y.Z>-nightly.<YYYYMMDD>` というタグの付いたプレリリースで、同じタグがすでに存在する場合は数値の接尾辞が付きます。ベースバージョンでは、CLI ソースのバージョンから RC の接尾辞を取り除きます。`1.2.3-rc.1` からも `v1.2.3-nightly.<YYYYMMDD>` が生成されるため、リリースの検出と保持ポリシーで同じタグ形式を使えます。リリースノートには、前回のナイトリー版以降のコミットを記載します。各リリースにはすべてのアーカイブと `SHA256SUMS` が含まれます。アセットは公開前のドラフトにアップロードされ、公開済みのリリースを上書きしたり編集したりすることはありません。保持するのは最新の **14 件のナイトリー版プレリリース**だけです。古いナイトリー版のリリースとタグは削除しますが、ナイトリー版以外のリリースは変更しません。

## タグ付き安定版リリースと npm

タグ付きリリースのワークフローでは、署名付きマニフェストとプラットフォーム別の npm パッケージを提供します。対応プラットフォーム、検証方法、メンテナー向けのチェックリストについては、[インストールとリリースの設定](install.md)を参照してください。ナイトリー版のワークフローは、引き続きアーカイブのみを提供します。インストールスクリプトと `amira update` は、今後の対応に持ち越しています。

`build:all` の後に、5 つすべてのプラットフォーム別パッケージとランチャーをステージングします。

```sh
bun scripts/npm-pack.ts
cd dist/npm/amira
npm pack --dry-run --ignore-scripts
```

ローカルでパッケージのスモークテストを行うには、対応する npm ターゲットをビルドし（x64 では `bun-windows-x64-baseline` または `bun-linux-x64-baseline` を使います）、そのターゲットを `bun scripts/npm-pack.ts --target <target>` に渡してください。ステージングではバージョン、チャネル、ターゲットを `dist/build.json` から読み取るため、以前のビルドの古い実行ファイルが気付かないうちに含まれることを防げます。生成されたパッケージには、LICENSE と必須の NOTICE 帰属表示が含まれます。ステージングで置き換えるのは、生成された `dist/npm/` 配下だけです。公開は一切行いません。
