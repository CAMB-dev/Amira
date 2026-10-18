# インストール

[English](../install.md) · [简体中文](../zh/install.md) · [ドキュメント](../../README.ja.md)

## パッケージマネージャー

次のいずれかを選んでください。

```sh
npm i -g amira
pnpm add -g amira
bun add -g amira
```

npm と pnpm のランチャーは、Node.js **18 以降**で動作します。実行ファイルにはランタイムが含まれるため、Bun は不要です。プラットフォームごとの実行ファイルはオプションの依存関係として提供されるため、オプションの依存関係を有効にしてください。Windows x64、Linux x64/ARM64（glibc）、macOS x64/ARM64 に対応しています。これらのパッケージは Linux musl には対応していません。

`amira` パッケージには小さなランチャーが含まれ、5 つのプラットフォーム別オプションパッケージのバージョンを、自身と完全に同じバージョンに固定しています。`amira-win32-x64` と `amira-linux-x64` は、AVX2 をサポートしない古い CPU 向けの **baseline** ビルドを使います。その他のパッケージは、対応するネイティブターゲットを使います。ランチャーは、引数、端末の入出力、終了ステータスを実行ファイルに引き継ぎます。

`amira --version` を実行すると、バージョン、チャネル、ターゲット、検出されたインストール元を確認できます。パッケージマネージャーでインストールした Amira は、自己更新を行いません。更新するには、そこに表示されるコマンド（`npm i -g amira`、`pnpm add -g amira`、`bun add -g amira` のいずれか）を実行してください。インストール元の検出には、実行ファイルのパスを使います。pnpm のストアまたはグローバルディレクトリと、Bun の `.bun/install/global` ディレクトリから、それぞれのパッケージマネージャーを識別します。それ以外の `node_modules` 内のインストールは npm として表示されます。そのため、npm 互換のディレクトリ構造を使う Bun の非グローバルインストールは、npm として表示される場合があります。

リリース候補版は、`npm i -g amira@next` のように `next` dist-tag を使います。ナイトリー版は GitHub Releases のアーカイブでのみ提供され、npm には公開されません。

## 単一実行ファイルのインストーラー

信頼できるリリースからスクリプトをダウンロードし、内容を確認してから実行してください。Amira の実行に Node.js や Bun は不要です。

macOS / Linux：

```sh
curl -fsSLO https://github.com/CAMB-dev/Amira/releases/latest/download/install.sh
sh install.sh --channel stable
# Pin a version: sh install.sh --version 1.2.3
# Try release candidates: sh install.sh --channel next
```

Windows（PowerShell）：

```powershell
Invoke-WebRequest https://github.com/CAMB-dev/Amira/releases/latest/download/install.ps1 -OutFile install.ps1
./install.ps1 -Channel stable
# Pin a version: ./install.ps1 -Version 1.2.3
# Try release candidates: ./install.ps1 -Channel next
```

スクリプトはアーカイブの SHA-256 とサイズをマニフェストと照合し、信頼済み公開鍵と検証ツールがあれば Ed25519 署名も検証します。署名を検証しない場合、チェックサムは破損を検出しますが発行者を認証しません。リポジトリのリリース公開鍵は初期状態では空です。インストーラーは警告し、Amira はメンテナーが新しいビルドに公開鍵を埋め込むまで更新確認を無効にします。

Windows では `%LOCALAPPDATA%\Amira\versions\<version>` に各バージョンを配置し、有効な実行ファイルを `bin\amira.exe` にコピーして、その `bin` をユーザー PATH に追加します。インストール後は新しい端末を開いてください。Unix では `~/.local/share/amira/versions/<version>` に配置し、`~/.local/bin/amira` を有効なバージョンへのシンボリックリンクにします。必要に応じて `~/.local/bin` を PATH に追加してください。`install.json` マーカーで自己管理インストールを識別します。設定、認証情報、セッションデータは引き続き `~/.amira` に保存します。

## 更新とロールバック

自己更新するのは、インストーラーで管理する単一実行ファイル版だけです。手動展開、npm/pnpm/Bun、ソース実行、開発ビルド、`0.0.0` 版は自己更新しません。パッケージマネージャー版で `amira update` を実行すると、対応する更新コマンドを表示します。`amira rollback` は利用できず、エラーで終了します。パッケージマネージャーでバージョンを選択してください。

```sh
amira update --check                # Check without installing
amira update                       # Install the selected channel's release
amira update --channel next         # Select release candidates for this command
amira rollback                     # Switch to the previous kept version
```

バックグラウンド確認は最大で 22 時間に 1 回です。パッチ更新は通知せずインストールし、次回起動時に有効になります。マイナー・メジャー更新は通知のみです。バックグラウンドでの失敗は表示しません。通知は TUI の通知バー、または対話的なプリントモードの stderr に表示し、機械可読出力には書き込みません。通常はロールバック用に 3 バージョンを保持し、起動時に Windows の `.old.<timestamp>.<pid>` ファイルを削除します。実行中のバージョンはセッションのリースで保護するため、そのセッションが終了するまで一時的に 4 バージョン以上を保持することがあります。インストーラーも同じリースを尊重します。実行中のセッションは元の実行ファイルを使い続けます。

**ユーザー設定**で `updates.auto`、`updates.channel`、`updates.minimumVersion` を指定できます。プロジェクト設定から更新方針は変更できません。最低バージョンは更新先とロールバック先を制限しますが、マイナー・メジャー更新を強制的に適用しません。ロールバックは更新ロック内で最低バージョンを確認し、回避フラグはありません。[設定リファレンス](settings.md)を参照してください。

環境変数（`1` で有効）：

- `AMIRA_DISABLE_AUTOUPDATE`：バックグラウンド確認とダウンロードを無効にします。明示的なコマンドは使えます。
- `AMIRA_DISABLE_UPDATES`：`amira update` を含む更新確認とインストールを無効にします。
- `AMIRA_OFFLINE`：起動時の確認を含む更新のネットワーク要求を停止します。

更新ロックはダウンロードと更新の書き込みを直列化します。別の短時間の保持ロックがリース登録、バージョン切り替え、削除を調整し、ネットワーク要求中は保持しません。起動時は短い競合を再試行しますが、別の更新プロセスのダウンロードを待ちません。リース登録はベストエフォートです。失敗してもセッションは開始し、保護を確立できない場合はそのセッションのバックグラウンド更新とローカルのバージョン削除を省略します。プロセスの中断後にロックが残った場合、そのロックを保持する Amira プロセスまたはインストーラーが終了したことを確認してから、インストール先の古いロックを削除してください。

## GitHub Releases のアーカイブ

同じ [GitHub Release](https://github.com/CAMB-dev/Amira/releases) から、対応するアーカイブ、`SHA256SUMS`、`manifest.json`、`manifest.json.sig` をダウンロードしてください。古い CPU では x64 baseline のアーカイブを選んでください。展開した `amira`（Windows では `amira.exe`）を PATH に追加します。展開した実行ファイルの実行に、Node.js や Bun のインストールは必要ありません。

展開する前に、アーカイブの SHA-256 を `SHA256SUMS` と照合してください。Linux で、リリースのすべてのアーカイブが現在のディレクトリにある場合は、次のコマンドを使います。

```sh
sha256sum --check SHA256SUMS
```

アーカイブを 1 つだけダウンロードした場合は、その項目だけを照合してください。macOS では `shasum -a 256 <archive>` を使います。Windows では PowerShell で `Get-FileHash <archive> -Algorithm SHA256` を実行し、結果を対応する項目と比較してください。チェックサムで検出できるのは破損であり、両方のファイルを差し替えられる攻撃者による改ざんではありません。

安定版とリリース候補版には、バージョン、チャネル、アーカイブ名、バイト単位のサイズ、SHA-256 ダイジェストを記載した、Ed25519 署名付きマニフェストも含まれます。信頼できる経路で取得した公開鍵を使って署名を検証し、その後でアーカイブのサイズとダイジェストを署名済みの項目と比較してください。信頼できないダウンロードと一緒に提供された公開鍵を信用しないでください。署名スクリプトのコマンドは以下を参照してください。Amira は `packages/cli/src/update/public-key.ts` の信頼済み公開鍵を埋め込みます。空の場合、自己更新の確認は無効です。既存のナイトリー版にはチェックサムが含まれますが、署名付きマニフェストは含まれません。

## メンテナー向けの初期設定（初回のみ）

1. npm アカウントを作成し、6 つすべてのパッケージ（`amira`、`amira-win32-x64`、`amira-linux-x64`、`amira-linux-arm64`、`amira-darwin-x64`、`amira-darwin-arm64`）を確保し、設定してください。**各パッケージ**で、このリポジトリの `release.yml` ワークフローを trusted publisher として設定します。trusted publishing を設定できるようになる前の初回公開には、npm トークンが必要な場合があります。
2. trusted publishing を利用できない場合は、必要最小限の権限を持つ npm 公開トークンを、リポジトリの Actions シークレット `NPM_TOKEN` として追加してください。リポジトリ内に保存したり、ローカルの検証コマンドに渡したりしないでください。公開ジョブは OIDC を要求し、npm provenance を使います。
3. 署名スクリプトで Ed25519 の鍵ペアを生成してください。秘密鍵の **PKCS8 PEM** を Actions シークレット `AMIRA_RELEASE_ED25519_KEY` として保存し、オフラインのバックアップを保管します。コマンドは公開鍵を表示します。リリースの検証に使えるよう、信頼できる経路で公開鍵を記録してください。ビルド前に `bun scripts/set-release-key.ts /secure/path/release-public.pem` を実行し、**公開鍵** PEM を埋め込んでください。このコマンドは Ed25519 公開鍵を検証し、公開鍵のソースファイルのみを変更します。公開鍵の変更を個別に確認してコミットしてください。秘密鍵は絶対にコミットしないでください。
4. リポジトリのリリース設定で、**不変リリース（immutable releases）**を有効にしてください。ワークフローはすべてのアセットをドラフトにアップロードしてから、一度だけ公開します。公開済みのリリースを編集することはありません。
5. 公開前に、**`v*`** を対象とするリポジトリのタグルールセットを有効にしてください。ナイトリー版の保持ポリシーでタグを削除できるよう、`v*-nightly.*` は除外します。このルールセットでは、リリースを実行する主体にもバイパスを認めず、タグの更新と削除を禁止してください。ワークフローは、リリースの作成と公開の直前に、リモートタグの参照先をたどったコミットが、チェック済みのコミットと一致することを確認します。その確認から公開までの間にタグが移動されるのを防ぐため、このルールセットが必要です。

最初の `next` 公開前に、リポジトリ内容への書き込み権限を持つ GitHub CLI 認証で、メタデータ用ブランチを明示的に予約してください。

```sh
bun scripts/publish-update-channel.ts bootstrap --repo CAMB-dev/Amira
```

このコマンドは、所有権マーカー `.amira-update-channel.json` のみを含む `update-channels` ブランチを作成し、既存のブランチの引き継ぎは拒否します。名前が使用済みの場合は、個別に確認して移行してください。リリースワークフローは上書きしません。強制プッシュと削除を禁止しつつ、メタデータジョブによるコミットの追加を許可してください。通常の公開は一致する所有権マーカーを要求し、想定外のファイルやモードを拒否し、バージョン比較前に候補と既存の両方のマニフェストの署名を検証します。欠落、無効、または信頼できないメタデータがあれば公開を停止し、新しいバージョンとして扱いません。

CI は署名用シークレットを直接メモリに読み込み、そこで公開鍵を導出します。秘密鍵をディスクに書き込むことはありません。シークレットがないドライランでは、一時的な鍵をメモリ内で生成します。以下のファイルを使うコマンドは、メンテナーがローカルで鍵を生成する場合にのみ使用してください。

リポジトリの外に秘密鍵を生成し（スクリプトは既存ファイルへの上書きを拒否します）、表示された公開鍵を `release-public.pem` として保存してください。

```sh
bun scripts/sign-manifest.ts keygen --key /secure/path/release-private.pem
```

リリースのアセットをダウンロードしたら、その信頼済みの公開鍵でマニフェストの署名を検証してください。

```sh
bun scripts/sign-manifest.ts verify --dist /path/to/downloads --public-key release-public.pem
```

この検証用ヘルパーを使うには、ソースをチェックアウトした環境で Bun が必要です。Amira 自体の実行には必要ありません。

## リリースのチェックリスト

タグを付ける前に、CLI のバージョンと `bun.lock` 内の対応するワークスペースの項目を同期してください（他のワークスペースのバージョンは独立したままです）。

```sh
bun scripts/version-sync.ts bump patch       # Or minor, major, rc
bun scripts/version-sync.ts sync v1.2.3      # Or an explicit v1.2.3-rc.1
bun scripts/version-sync.ts check v1.2.3
```

受け付けるのは `vX.Y.Z` と `vX.Y.Z-rc.N` のみです。タグは `packages/cli/package.json` のバージョンと一致する必要があります。安定版はチャネル `stable` と npm dist-tag `latest` を使い、リリース候補版はチャネルと dist-tag の両方に `next` を使います。

リリースワークフローはすべてのチェックを実行し、7 つすべてのターゲットをクロスコンパイルして、Windows、Linux、macOS でアーカイブのスモークテストを行います。スモークテストのジョブでは Bun をインストールしません。macOS x64 と Linux ARM64 には、現在ネイティブのスモークテスト用ランナーがありません。その後、マニフェストに署名し、GitHub Release を公開して、メインパッケージの**前に**プラットフォーム別 npm パッケージを公開します。再実行時は、すでに npm に存在するバージョンをスキップします。

まず、リリースタグを対象に `dry-run` を有効にして `workflow_dispatch` を実行してください。ビルド、チェック、署名、`npm publish --dry-run` の実行を行いますが、リリースの作成やパッケージの公開は行いません。ナイトリー版が npm に公開されることはありません。ローカルのビルドコマンドについては、[Amira のビルド](building.md)を参照してください。リリースアセットには、実行ファイルと同じ信頼済み公開鍵を持つ `install.sh` と `install.ps1` が含まれます。`next` チャネルは `https://raw.githubusercontent.com/CAMB-dev/Amira/update-channels/next/manifest.json`（および `.sig`）から署名済みメタデータを直接取得し、GitHub API を使いません。直列化したワークフローが専用ブランチを新しいバージョンにのみ進めます。Actions トークンによるこのブランチの更新を許可してください。アーカイブは常に不変のバージョン別リリースから取得します。
