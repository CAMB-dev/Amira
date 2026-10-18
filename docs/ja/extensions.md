# 拡張機能の利用と作成

[English](../extensions.md) · [简体中文](../zh/extensions.md) · [ドキュメント](../../README.ja.md)

拡張機能は、ツール、コマンド、UI の動作を追加します。インストールしたパッケージには、複数の拡張機能、スキル、トップレベルの CLI コマンドを含めることができます。拡張機能は、あなたの権限でコンピューター上のコードを実行します。

## パッケージの検索と管理

```sh
amira ext search
amira ext search workflow
amira ext list
amira ext help
```

検索には [CAMB-dev/amira-extensions](https://github.com/CAMB-dev/amira-extensions) の公式インデックスを使用します。通常、キャッシュしたコピーを 1 時間再利用します。`--refresh` を指定すると再取得します。`AMIRA_EXTENSIONS_INDEX` で別のインデックス URL またはローカルのインデックスファイルを指定できます。インデックスにはパッケージとその取得元が掲載されています。検索してもインストールはされません。このリポジトリには公式の拡張機能自体もあり、それぞれに README が付属しています。workflow と swarm（[サブエージェント](subagents.md#workflow-と-swarm-の拡張機能)を参照）、lsp diagnostics、file checkpoints、hooks、todo、notify、share、browser、images、mermaid があります。

検索結果の名前、ローカルディレクトリ、任意の ref を付けた git URL、または npm パッケージの取得元を指定します。

```sh
amira ext install <name>
amira ext install ./my-extension
amira ext install https://github.com/owner/repo.git#main
amira ext install npm:package-name
amira ext update <name>
amira ext disable <name>
amira ext enable <name>
amira ext remove <name>
```

これらのコマンドは、複数のパッケージ名や取得元を受け付けます。名前を指定せずに update を実行すると、選択したスコープのすべてのパッケージを更新します。取得元を指定せずに install を実行すると、そのスコープのロックファイルから不足しているパッケージを復元します。disable はパッケージとロックファイルのエントリを残します。remove は両方を削除します。install、update、remove では、結果と警告だけを表示する `--quiet`、または結果オブジェクトを 1 行ずつ出力する `--json` を使用できます。

インストールと更新では、`experimental` のパッケージには案内を、`wip` と `deprecated` のパッケージには警告を表示します。`--quiet` は実験的なパッケージの案内を省略しますが、警告は残します。`--json` は、構造化された `status` オブジェクト（`kind` と、任意の `message`、`replacedBy`）を持つ独立した `type: "status"` イベントを出力します。結果イベントの `status` は、従来どおり操作結果を表します。`amira ext list --json` は配列を返し、対象のパッケージに同じ構造のステータスオブジェクトを含めます。

install はローカルディレクトリをパッケージのスコープにコピーします。元のディレクトリと連動するリンクではありません。元のディレクトリを編集したら、もう一度インストールしてください。Git のコミットと npm のバージョンは `packages.lock` に厳密に固定されます。update は取得元を再解決し、新しい固定値を書き込みます。

パッケージのインストール、更新、削除、有効化・無効化の変更を読み込むには、Amira を再起動するか、アイドル時に `/reload` を実行します。`/help` は、読み込まれた拡張機能が登録したコマンドを一覧表示します。

### Git リポジトリのキャッシュ

Git パッケージは `~/.amira/cache/git` のベアリポジトリを共有します（`AMIRA_HOME` を設定した場合は、その配下になります）。ユーザーのロックファイル、または既知のプロジェクトのロックファイルで固定されているキャッシュは、パッケージのファイルがなくなっていても、プロジェクトが信頼されていなくても保持されます。既知のパスは、セッションヘッダーと信頼済み・未信頼のプロジェクト設定から取得します。Amira は、それらのパス配下にあるプロジェクトのロックファイルも確認します。固定されていないキャッシュは、30 日間使用されなければ自動的に削除されます。

```sh
amira ext cache list
amira ext cache prune --dry-run
amira ext cache prune
amira ext cache prune --all --dry-run
amira ext cache prune --all
```

`prune` は、30 日を待たずに固定されていないリポジトリを削除します。`ext gc` はその別名です。`--dry-run` は、削除せずに、削除対象となるリポジトリと中断されたクローンを一覧表示します。`--all` は固定されているリポジトリも削除します。`cache clean` は `cache prune --all` の別名です。別の Amira 操作によってロックされているリポジトリは常に保持されます。キャッシュを削除しても、インストール済みのパッケージやロックファイルは変更されません。ただし、不足しているパッケージを復元する際には、再びネットワークが必要になることがあります。

キャッシュを調べる際に、不足しているオブジェクトをダウンロードすることはありません。Git 2.45 以降は `GIT_NO_LAZY_FETCH` をサポートしています。古い Git では、コマンドに限定した設定で origin の promisor を無効にし、調査中の転送をブロックします。キャッシュされたリポジトリの設定は変更しません。fetch やパッケージのチェックアウトでは、引き続き必要なオブジェクトをダウンロードできます。

### Amira 内でのパッケージ管理

`/ext` を使うと、セッションを離れずに同じ操作を行えます。引数なしで実行すると、インストール済みのパッケージ（スコープ、有効かどうか、信頼されているかどうか、インデックスに新しいバージョンがあるかどうか）に続いて、インデックスから入手できるパッケージの一覧を開きます。インストール済みのパッケージで Enter を押すと、設定（読み込まれた拡張機能が宣言している場合）、更新、有効化・無効化、削除、詳細の操作が表示されます。入手可能なパッケージで Enter を押すと、ユーザーまたはプロジェクトのスコープを選んでインストールします。`d` で詳細を表示します。一覧で使用できるキーは、[キー割り当て](keybindings.md#ダイアログ)を参照してください。

```text
/ext
/ext config hello-extension
/ext search lsp
/ext install todo
/ext install todo --project
/ext update
/ext disable todo
/ext remove todo --project
```

`install`、`remove`、`disable`、`enable` は名前を 1 つ受け付けます。`update` は任意の数の名前を受け付け、名前を省略するとスコープ内のすべてのパッケージを対象にします。install、update、remove では、`--project` でプロジェクトのスコープを選択します。規則は CLI と同じです。プロジェクトへのインストールには、そのプロジェクトが信頼されている必要があります。disable と enable はユーザー設定を通じて両方のスコープに適用されます。install と update は進捗パネルを表示し、その間も入力を続けられます。Esc または Ctrl+C で実行中の操作をキャンセルしても、下書きは保持されます。インストールはすべて成功するか、何も変更しないかのどちらかで、完了済みの更新は保持されます。

`/ext` が独自に拡張機能のコードを再読み込みすることはありません。パッケージを変更すると、`/reload` の実行、または現在のターン終了後の実行が提案されます。設定を保存すると、再読み込みせずに拡張機能へ即座に通知されます。`/ext` の操作が終了するまで、`/reload` は実行を拒否します。未信頼のプロジェクトにインストールしたパッケージは、次回起動時にプロジェクトを信頼するか、`amira ext trust` を実行して再起動すると読み込まれます。print モードと RPC モードでは、サブコマンドを引用符で囲んだスラッシュコマンドとして使用できます。一覧の表示には対話型 UI が必要です。

## ユーザースコープ、プロジェクトスコープ、信頼

デフォルトのスコープでは `~/.amira/packages` にインストールし、ロックファイルを `~/.amira/packages.lock` に保存します。`AMIRA_HOME` でこのユーザーディレクトリを変更できます。現在のプロジェクトの `.amira/packages` でインストール、更新、削除を行うには、`--project` を追加します。そのロックファイルは `.amira/packages.lock` です。

```sh
amira ext install ./my-extension --project
amira ext update --project
amira ext remove <name> --project
amira ext trust
amira ext untrust
```

信頼済みのプロジェクトパッケージは、同名のユーザーパッケージを置き換えます。信頼されていない場合、プロジェクトパッケージはスキップされ、ユーザーパッケージは引き続き読み込めます。パッケージがあるプロジェクトで初めて対話型で起動すると、Amira は **Load them? [y/N]** と尋ね、その回答をユーザー設定に保存します。print モードと RPC モードでは質問できないため、事前に信頼されていないプロジェクトパッケージを読み込みません。

この信頼により、プロジェクトの `allow` [権限ルール](usage.md#権限)も適用できるようになります。`ask` と `deny` のルールは、信頼の有無にかかわらず適用されます。

プロジェクトディレクトリで trust または untrust を実行してから、Amira を再起動してください。この判断と無効なパッケージの一覧はユーザー設定に保存されます。プロジェクト設定で自らを信頼したり、パッケージを再び有効にしたりすることはできません。名前を指定して無効にすると、両方のスコープに適用されます。

1 回の起動でインストール済みのすべてのパッケージをスキップするには、`--no-packages` を使用します。`--extension` で明示的に指定したファイルは引き続き読み込まれます。コードを実行するつもりのあるパッケージだけをインストールしてください。

## パッケージマニフェスト

パッケージが提供する機能は、`amira-package.json`、または `package.json` 内の `amira` オブジェクトに記述します。拡張機能、スキル、テーマのパスは、パッケージの内部に収まる必要があります。マニフェストでは次の項目を宣言できます。

| フィールド | 用途 |
| --- | --- |
| `name` | 小文字の npm 形式のパッケージ名 |
| `version` | Semver バージョン。省略時は `0.0.0` |
| `engines.amira` | サポートする拡張機能 API のバージョン範囲 |
| `extensions` | 拡張機能モジュールのパス |
| `skills` | スキルディレクトリのパス |
| `themes` | テーマの JSON ファイルのパス。デフォルト値は `[]`（[テーマ](themes.md)を参照） |
| `commands` | トップレベルの CLI コマンド名とモジュールの対応 |
| `status` | 任意：`experimental`、`wip`、`deprecated` のいずれか |
| `statusMessage` | 任意のステータス説明 |
| `replacedBy` | 任意の代替パッケージ名。`deprecated` の場合のみ使用し、それ以外は無視 |

エンジンのバージョン範囲は拡張機能 API を表すもので、CLI のリリースバージョンではありません。[公開 API](../../packages/api/src/index.ts) がエクスポートする `API_VERSION` で現在の値を確認できます。拡張機能の一覧がない場合、Amira は `index.ts`、次に `src/index.ts` を探します。コマンドのみ、またはテーマのみのパッケージでは、拡張機能のエントリを省略できます。

### 拡張機能のステータス

ステータスメタデータはすべて任意です。`package.json` では `amira` オブジェクト内の `amira.status`、`amira.statusMessage`、`amira.replacedBy` に指定します。`amira-package.json` では同じ名前のフィールドをトップレベルに指定します。`experimental` は実験的なパッケージ、`wip` は開発途中、`deprecated` は利用を推奨しなくなったパッケージを示します。`statusMessage` で補足し、非推奨のパッケージでは `replacedBy` で代替パッケージを指定できます。

不明なステータスは無視され、マニフェストの警告が出ます。ステータスメタデータやその警告がインストールや読み込みを妨げることはありません。`replacedBy` が代替パッケージを自動でインストールすることもありません。

`index.json` の各エントリでも、同じ任意の `status`、`statusMessage`、`replacedBy` をトップレベルに指定できます（`amira` の下には入れません）。これにより、インストール前の検索時にもステータスを確認できます。ステータスの値と `replacedBy` の制限は同じです。インデックスのステータスはダウンロード前に通知され、インストール済みのメタデータではマニフェストの有効なステータスを優先します。マニフェストに有効なステータスがない場合、オフラインの一覧や設定ページで使えるよう、インデックスのメタデータをロックファイルに保持します。

`amira ext list`、`/extensions`、拡張機能の設定ページにステータスバッジが表示されます。セッション開始時や、拡張機能独自のコマンドやビューを使う際には、ステータスの案内は表示されません。

## 小さな拡張機能の完全な例

`hello-extension` というディレクトリを作成し、次の 2 つのファイルを配置します。この拡張機能はユーザーコマンドとステータスカウンターを追加し、モデルへのリクエストは送信しません。

`amira-package.json`:

```json
{
  "name": "hello-extension",
  "version": "1.0.0",
  "engines": { "amira": "^0.1.7" },
  "extensions": ["index.ts"]
}
```

`index.ts`:

```ts
import { defineExtension } from "@amira/api"

export default defineExtension((api) => {
  const settings = api.settings.declare({
    fields: [
      { key: "message", type: "text", label: "Greeting", default: "Hello from an extension.", maxLength: 120 },
    ],
    preview: (draft) => ({ lines: [{ kind: "text", text: draft.message }] }),
  })
  settings.onChange(() => api.requestRender())
  let greetings = 0

  api.registerStatusItem({
    id: "hello-extension.count",
    align: "right",
    text: () => greetings > 0 ? `Hello: ${greetings}` : undefined,
  })

  api.registerCommand({
    name: "hello",
    description: "Print a greeting and update its status counter",
    run(_args, ctx) {
      greetings += 1
      ctx.print(settings.get().message)
      api.requestRender()
    },
  })
})
```

使用するプロジェクトで次を実行します。

```sh
amira ext install ./hello-extension
amira
```

`/hello` を実行してください。呼び出すたびに会話記録へ挨拶を出力し、ステータス項目を更新します。カウンターは、読み込まれたこの拡張機能に属します。再起動や再読み込みでリセットされ、セッションには保存されません。

必要に応じて、設定で挨拶をカスタマイズできます。

```json
{
  "extensions": {
    "hello-extension": { "message": "Welcome to this project." }
  }
}
```

`/ext config hello-extension` を開くと、ライブプレビューを確認しながら挨拶を編集できます。保存すると、次の `/hello` に即座に反映されます。再起動は不要です。`amira --extension ./hello-extension/index.ts` で、単独の拡張機能ファイルとして開発することもできます。この方法では、マニフェストをインストールせずにファイルを直接読み込みます。このオプションは複数回指定でき、相対パスはコマンドを開始したディレクトリから解決されます。Amira は、単独のファイルも含めて `@amira/api` の実行時インポートを提供します。このパッケージを実行時用に別途インストールする必要はありません。

## API ガイド

通常は `defineExtension` でラップした関数を、デフォルトエクスポートします。Amira は拡張機能の読み込み時に、`ExtensionAPI` を渡してこの関数を呼び出します。関数は Promise を返してもかまいません。公開拡張機能 API は `@amira/api` からインポートしてください。完全な型定義は [packages/api/src](../../packages/api/src) を参照してください。

| API | 追加する機能や動作 |
| --- | --- |
| `registerTool`, `defineTool`, `textResult` | JSON スキーマと非同期の実行処理を持つモデルツール。テキストまたは画像のコンテンツと、任意のレンダラー詳細を返します |
| `registerCommand` | 引数、補完、任意の別名を持つスラッシュコマンド。コマンドコンテキストで出力やセッションの制御を行います |
| `registerSkill` | ユーザーが `$` を先頭に付けた名前で呼び出すスキル |
| `registerInputHandler` | 通常の入力がモデルに届く前に、条件に一致する入力を処理します |
| `registerStatusItem`, `requestRender` | 現在の状態をステータスバーに表示し、状態変更後に再描画を要求します |
| `on`, `intercept` | 型付きイベントを購読するか、文書化されたモデル・ツール・コンテキストの処理段階に介入します |
| `complete` | ツールやホスト型 Web 検索を使わず、ホスト側で使用量を計上する補助的なモデル呼び出しを行います |
| `session` | ホストが注入済みの場合、コマンド外から現在のトップレベルの `SessionControl` にアクセスします |
| `ui` | 選択、確認、入力、フォーム、レビューのダイアログで質問します。コマンドコンテキストからも UI リクエストを利用できます |
| `registerPanel` | アクティビティ行の上にライブ表示の行を描画します |
| `registerView` | 全画面またはドック表示のビュー種別を登録します。フロントエンドが対応していれば、コマンドから `openView` で開けます |
| `registerToolRenderer`, `decorateToolRenderer` | ツール呼び出しと結果を表示するか、既存の表示処理をラップします |
| `serverToolView` | ネイティブ Web 検索など、プロバイダーがホストするツールのブロックを、表示処理で使用するものと同じツール呼び出しビュー形式に変換します |
| `registerMarkdownRenderer`, `registerImageProvider` | 条件に一致する返信のコードブロック、数式、単独の画像を描画し、端末用の画像データを提供します |
| `provideService`, `useService` | 名前付きの拡張機能サービスを共有します。提供側が存在しない、またはアンロードされている場合があるため、必要な時点で検索します |
| `settings.declare` | 順序付きの設定フィールドと、任意の分離されたプレビューを宣言します。`get()` で型付きの値を読み取り、`onChange()` で変更を購読します |
| `settings`, `cwd`, `home`, `apiVersion` | マージ済みの設定、トップレベルの各キーの出所となるレイヤー、作業ディレクトリ、ユーザーディレクトリ、API バージョンを読み取ります |
| `dataDir` | この拡張機能の永続状態ディレクトリを表す、必須の読み取り専用の絶対パス。初回アクセス時に作成されます |
| `backgroundJobs` | この拡張機能のバックグラウンドジョブのみを開始・確認します。組み込みフロントエンドのコードは、ホスト専用の `hostBackgroundJobs()` 機能を使用します |
| `runCommand`, `openPipe`, `onExit` | 管理対象のサブプロセスを実行するか、長時間動作するパイプ接続のプロセスを開くか、終了時の短い処理を登録します |
| `onUnload` | アンロード、再読み込み、終了時の同期的なクリーンアップを登録します |
| `notify`, `reportError` | 通知を表示するか、バックグラウンドでの失敗を報告します |
| `registerFileRestoration` | 巻き戻し時のファイル復元を引き継ぎます（チェックポイント拡張機能など）。選択画面には指定したラベルが表示され、コアは何も復元しません。所有者は一度に 1 つだけで、アンロード時に解放されます |

### アンロード時のクリーンアップ

タイマー、購読、処理待ちの作業に使う `AbortController` など、自分で作成したリソースには `api.onUnload(() => { ... })` を登録します。戻り値は、このフックを削除する関数です。登録した各フックは、このインスタンスのアンロード時に 1 回実行されます。対象は `/reload`、無効化・削除の反映時、読み込み失敗後、終了時です。最初にドックと全画面ビューが閉じられ、登録がまだ有効な間に `onClose` が 1 回呼ばれます。その後、登録が削除される前にアンロードフックが実行されます。フックが失敗しても報告されるだけで、残りのクリーンアップは続行されます。

クリーンアップは同期的で、返された Promise は待機されません。アンロード中に完了する必要がある永続化処理には同期処理を使用し、終了時だけ必要となる、実行時間に上限のある非同期処理には `api.onExit` を使用してください。終了ハンドラーはアンロード時のクリーンアップより先に実行されます。

```ts
const pending = new AbortController()
const timer = setInterval(refresh, 1000)
api.onUnload(() => {
  pending.abort()
  clearInterval(timer)
})
```

### 拡張機能の設定の宣言

`api.settings.declare(...)` で設定を一度だけ宣言します。拡張機能の識別子はホストが提供します。インストール済みのパッケージは `extensions.<package-name>.<key>` に書き込み、単独のファイルはホストが把握している絶対パス（Windows では小文字化）を `extensions` 配下のキーとして使用します。コマンドの別名が、この保存先の識別子を変えることはありません。識別子ごとに宣言できるのは 1 回だけで、2 回目の宣言は読み込みエラーになります。フィールドの順序がページ上の順序になります。`settings.get()` は、キーと型が推論された、検証済みの読み取り専用オブジェクトを返します。ファイル内の値が欠けているか不正な場合は、宣言したデフォルト値を使用します。不正な値は、ファイルとキーを含む設定の問題として報告されます。

```ts
import { defineExtension, type MarkdownRenderContext, type MarkdownRenderResult } from "@amira/api"

export default defineExtension((api) => {
  // Share this pure helper with the real renderer; always pass its settings explicitly.
  const renderSample = (
    mode: "text" | "image",
    size: number,
    ctx: MarkdownRenderContext,
  ): MarkdownRenderResult => ({
    lines: [{ kind: "text", text: `Sample: ${mode}, ${size}px (${ctx.width} columns)` }],
  })
  const settings = api.settings.declare({
    fields: [
      { key: "size", type: "number", label: "Size", description: "Font size in pixels.", default: 16, min: 8, max: 64, step: 1 },
      { key: "mode", type: "choice", label: "Mode", default: "text", options: ["text", "image"] },
      { key: "enabled", type: "toggle", label: "Render samples", default: true },
      { key: "colour", type: "colour", label: "Colour", default: "#88aaff" },
    ],
    preview: (draft, ctx) => renderSample(draft.mode, draft.size, ctx),
  })
  settings.onChange((values) => {
    // Invalidate extension-owned render caches here if necessary.
    api.requestRender()
  })
  api.registerCommand({
    name: "sample",
    description: "Print the saved sample settings",
    run(_args, ctx) {
      const values = settings.get()
      ctx.print(`${values.mode}: ${values.size}px`)
    },
  })
})
```

フィールドの型は 5 種類です。`number`（任意の `min`、`max`、`step`）、`toggle`、`choice`（`options` は文字列または `{ value, label?, description? }`）、`text`（任意の `placeholder`、値全体に対する `pattern`、`maxLength`）、`colour`（`#rrggbb`）です。各フィールドには、階層のない `key`、`type`、`label`、`default` が必要で、`description` は任意です。デフォルト値と制約は宣言時に検証されます。`onChange` は、設定ページや設定の再読み込みによって、保存済みの実効値が変わったときに実行されます。購読解除用の関数を返し、アンロード時には削除されます。値を使用する場所で `get()` を使って読み取るか、このコールバックで拡張機能の状態を更新してください。ファイルシステムが自動監視されるわけではありません。外部で編集したファイルは、ホストによる設定の再読み込み（`/reload`）で反映されます。

テキストの `maxLength` は UTF-16 コード単位ではなく Unicode コードポイントを数えます。`🚀` は 1 つ、`e` と結合アクセントの組み合わせは 2 つと数えます。編集時の切り詰めはコードポイント間でのみ行われ、検証では、デフォルト値、ファイル、保存する下書き内の対になっていないサロゲートを拒否します。`onChange` コールバックは非同期でもかまいません。同期的な例外と、返された Promise の拒否は、拡張機能のエラーとして報告されます。保存やその他の通知は、非同期コールバックの完了を待ちません。

プレビューは任意です。下書きと描画コンテキスト（`width`、`theme`、`images`、`maxImageRows`、`signal`）を受け取り、既存の `MarkdownRenderResult` を返します。返せるのは、スタイル付きの `lines`、インラインの `segments`、または `alt`/`fallback` 付きの `image` です。生成した KaTeX 画像など、Promise を返すこともできます。ホストは完了時に再描画し、置き換えられたプレビューや閉じたプレビューを中止します。コールバックが signal を無視しても、古くなった結果は無視します。実際のレンダラーと同じ描画ヘルパーを使い、設定を引数として明示的に渡してください。これは、通常の Markdown レンダラーに下書きを一時的に注入するより簡単で安全です。保存済みの値の読み取り、通知、通常の描画、キャッシュが、未保存の下書きを参照することはありません。拡張機能は、プレビューのコールバックから通常の描画状態を変更してはいけません。

`/ext` では、設定を宣言した読み込み済みのパッケージに **Settings** が表示されます。設定を宣言した単独のファイルは、別の **Standalone** セクションに表示され、**Settings** と **Show details** を選べます。パッケージのインストール・更新・削除の操作は表示されません。`/ext config <name>` でページを直接開けます。config の補完には単独のファイルの名前も含まれます。ホストは各単独ファイルの拡張子を除いた名前から名前を生成し、空白や、ASCII の英字、数字、`_`、`-` 以外の文字を `-` に置き換えます（たとえば、`my extension.ts` は `my-extension` になります）。拡張子を除いた名前が空の場合は `extension` になります。他のファイルやパッケージ名と重複すると、絶対パス順に `-2`、`-3` などを付けます。`/ext` に表示された名前を使うか、絶対パスを引用符で囲んで指定してください。例は `/ext config "/path/to/my extension.ts"` または `/ext config "C:\\extensions\\my extension.ts"` です。単一引用符も使用でき、バックスラッシュはそのまま扱われます。読み込むファイルやインストール済みのパッケージが変わると別名も変わることがありますが、保存済みの設定は元のパスの識別子に紐づいたままです。プレビューは操作項目の上に表示されます。プレビューがない場合は操作項目だけを表示します。Up/Down で行を移動し、Left/Right または `-`/`+` で数値を step の値だけ変更し、数字の入力で範囲内に制限した数値を設定し、Left/Right で選択肢を切り替え、Space でオン・オフを切り替えます。テキストと色は 1 行入力です。フォーカスした行には、説明が折り返して表示されます。`ctrl+r` でその行をデフォルト値に戻せます。デフォルト値と異なる値にはマーカーが付きます。

変更はプレビューに反映されますが、まだ保存されません。Enter を押すと、その場でユーザー設定とプロジェクト設定のどちらに保存するか尋ねられます。デフォルトの選択は現在の値の取得元レイヤーで、未設定ならユーザーです。もう一度 Enter を押すと、無関係なキーと設定書き込み処理が対応する書式を維持して、そのレイヤーに保存します。Esc は下書き全体を破棄します。より優先度の高いプロジェクト個人設定（`settings.local.json`）またはフラグの値が、保存したユーザー・プロジェクトの値を引き続き上書きすることがあります。ページには値の出所が表示されるため、それを確認して選べます。

### 拡張機能の状態ディレクトリ

D111 では、必須の `readonly dataDir: string` プロパティが `ExtensionAPI` に追加されています。`api.dataDir` は `<api.home>/extension-data/<sanitized host-known identity>` にある絶対パスです。ディレクトリ名は、決定的で読みやすい、使用可能な文字に置き換えたスラッグと、元の識別子の SHA-256 ハッシュを組み合わせます。そのため、置き換え後のスラッグが同じでも、識別子は区別されます。ホストが明示的に指定した `loadFile` の名前（インストール済みのパッケージ名）が識別子になります。それ以外のファイル読み込みでは、ファイル名や表示ラベルではなく、絶対パス（Windows では大文字・小文字を統一）を使用します。明示的な名前を指定しない直接読み込みでは、デフォルトでその取得元を使用します。1 つのインストール済みパッケージ内にあるすべての拡張機能モジュールは、同じディレクトリを共有します。拡張機能が自ら所有者の識別子を選ぶことはできません。

ホストは `api.dataDir` への初回アクセス時にディレクトリを作成します。アクセスしない拡張機能ではディレクトリは作成されません。内容はアンロードや再読み込み後も保持されます。そのディレクトリを削除すると、拡張機能が保存した状態はリセットされ、後で読み込んだ際の初回アクセスで再作成されます。キャッシュや管理情報などの拡張機能の状態に使用し、ユーザーファイルやプロジェクトの出力には使用しないでください。

拡張機能のツールが保護対象への書き込み承認を免除されるのは、`traits.writesFiles: "paths"` を明示的に宣言し、`getWrittenPaths` を提供し、書き込み報告の和集合に含まれるすべてのパスが、自身の `api.dataDir` 内に安全に収まる場合だけです。組み込みのファイルツール名で登録したツールでは、その和集合に引数で指定されたパスも含まれます。報告はファイルツールのパスの意味規則に従います。相対パスは `api.dataDir` ではなく、呼び出し元エージェントの `cwd` から解決されます。ディレクトリ内外のパスが混在する報告に、部分的な免除はありません。呼び出し全体に対して、外部のパスも含め、通常の保護対象パスの確認を維持します。パスの解決結果が欠けている、不正、不明、または安全でない場合は、免除を認めず承認を求めます。

ディレクトリ内に収まるかの確認には、文字列の前方一致だけではなく、既存のパスの先頭部分に対するネイティブファイルシステムの realpath を使用します。そのため、新しいファイルでも、既存の親ディレクトリを通じて確認できます。`extension-data` 名前空間や所有者のディレクトリを別の場所へ転送する構成は、転送先がユーザーディレクトリ内でも拒否されます。`api.home` 自体のシンボリックリンクは許可されます。シンボリックリンクやジャンクションによる外部への逸脱、曖昧な Windows パス形式は、免除の対象になりません。シンボリックリンクの後に `..` が続く場合や、`..` より前の親を安全に解決できない場合は、正規化されたパスを信頼せず、承認を求めます。

この免除は、包含する Amira ホームディレクトリの保護にのみ適用されます。Git メタデータ、`.gitmodules`、設定済みの hooks パス、入れ子の `.amira` ディレクトリには、引き続き承認が必要です。plan モードでは引き続き書き込みを拒否します。シェルの権限ルールやインターセプターからの承認要求は変わらず、サブエージェントにも同じポリシーを適用します。パス報告は、信頼された拡張機能の宣言です。シェルのサンドボックス、競合状態のない認可、排他的な所有の証明ではありません。ハードリンクは、ディレクトリ外から同じファイルを参照できる場合があります。カスタムツールは、報告と実際のファイルアクセスを、ファイルツールの意味規則に合わせて一貫して解決する必要があります。[権限](usage.md#権限)を参照してください。

### ツールの結果と表示用の行

ツール結果の `content` は、モデルに渡すテキストや画像です。任意の `details` には構造化した表示用データを格納でき、デフォルトでは一時的なものです。結果に `persistDetails: true` を設定すると、再開した会話記録や `/agents` を含む保存履歴に、詳細の JSON スナップショットを保持できます。組み込みのプロバイダー用シリアライザーは、details をモデルへ送信しません。

各結果が永続化できる詳細は、JSON の引用符とエスケープを含む、**シリアライズ済みの UTF-8 で最大 16 KiB（16,384 バイト）**です。上限を超えた詳細や、循環参照、`BigInt` などシリアライズできない値は、**切り詰めずに破棄します**。ライブ表示の処理には引き続き元の詳細が渡されます。履歴では保存済みの結果テキストまたはアーティファクトのプレビューにフォールバックします。`content` は、details がなくても役立つ内容にしてください。details のない古いセッションも引き続き読み込めます。`ask_user` は、その保存済みテキストから選択内容を推測しません。

ツールの表示処理、全画面の `ViewLine` 値、ブロック Markdown レンダラーは `ToolLine` を共有します。行には `kind` と `text` に加えて、次の項目を設定できます。

- `wrap: true`: テキストを切り詰めず、利用可能な列数に合わせて折り返します。
- `marker: "success" | "unchecked"`: ASCII テーマも含め、テーマの成功または未選択の記号を先頭に付けます。マーカーは 1 回だけ表示され、折り返し行はラベルの下に揃います。成功マーカーには成功の色、未選択マーカーには控えめな色を使い、`kind` がラベルの色を制御します。
- `description: string`: ラベルの後に説明が収まる場合は控えめな色で表示し、収まらない場合はラベルの下に折り返します。説明は論理行ごとに 1 回だけ表示します。

マーカーと説明も折り返しを要求するため、選択肢の行に別途 `wrap` を設定する必要はありません。たとえば、`{ kind: "text", text: "Patch", marker: "success", description: "Fix it in place", wrap: true }` は、選択済みの項目を通常色のラベルと控えめな色の説明で表示します。これらのフィールドは表示内容を記述するもので、モデルに送信するツール結果を変更しません。コアは Markdown レンダラーの説明をテキストと同様にサニタイズします。ブロックの行数制限は変わりません。

### Markdown と数式のレンダラー

`api.registerMarkdownRenderer({ id, match, render })` は、完成した返信ノードの描画を担当します。フェンス付きコードブロックには `match: { codeLang: ["latex", "tex"] }`、単独の画像には `{ image: true }`、数式には `{ math: "inline" | "display" | "both" }` を使用します。数式ノードは `{ type: "math", display: boolean, source: string }` で、`source` に区切り記号は含まれません。レンダラーは優先度の降順、次に登録順で実行されます。`undefined` を返す、例外を投げる、不正な結果を返す場合は、次のレンダラーが試します。どのレンダラーもノードを担当しない場合、既存の Markdown 描画は変更されません。

別行立ての数式は、複数行も含めて `$$…$$` または `\[…\]` をブロックとして使用します。単独行の `$$` はブロックの開始になります。レンダラーが担当するコードブロックと同じく、別行立てのブロックはストリーミング中はソースのままで、終了区切りが届いてから描画します。閉じられていない数式は、返信が終了してもソースのままです。インライン数式は、段落内で `$…$` または `\(…\)` を使用し、コードスパンやコードブロック内では使用しません。開始の `$` の後に空白は置けず、終了の `$` の前に空白、後に数字は置けません。`\$` はリテラルです。`$5 and $10` のような通貨表記は数式ではありません。

インライン数式は `{ segments: [{ kind: "text", text: "x²" }] }` を返す必要があります。スタイル付きのテキスト断片を段落内に連結し、段落とともに折り返します。インライン画像とブロックの `lines` の結果は拒否されます。別行立ての数式、コードブロック、単独の画像は、`{ lines: ToolLine[] }` または `{ image: ImageInput, alt?: string, fallback?: ToolLine[] }` を返します。画像の説明には `alt`、読みやすいテキスト表現には `fallback` を使用してください。画像を表示できない場合や、会話記録をコピー・出力する場合は、フォールバックの行が代替テキストより優先されます。どちらもない場合は元のノードがフォールバックになります。コアはレンダラーのテキストからエスケープシーケンスと制御シーケンスを取り除き、ブロック結果を 2000 行に制限します。

コンテキストには、`width`、`images`、`maxImageRows`、`theme: { dark: boolean, foreground?: string, background?: string }` が含まれます。画像処理を行う前に `images` を確認してください。通常の `amira -p` は、完成したノードを `images: false` で同じレジストリに渡し、担当されなかったソースは保持します。この場合はテキストを返してください。フォールバックや代替テキストを持つ画像結果は、テキストに変換します。`waitMs` 以内に応答しないレンダラーはスキップされ、ソースが出力されます。`--json` は元のイベントを保持し、レンダラーを実行しません。

TUI のライト・ダークテーマは、起動時に端末の背景色を調べて選択します（OSC 11、次に `COLORFGBG`、デフォルトはダーク）。選択はセッション中固定されます。レンダラーのコンテキストは、モノクロモードも含め、同じ選択を使用します。正確な前景色・背景色は現時点では不明なため、省略されます。非対話型の print モードのデフォルト値は `{ dark: true }` です。描画キャッシュのキーにはテーマが含まれます。全画面の返信は非同期の結果が届くと再描画し、それまでは Amira の描画を表示します。`MarkdownRendererDefinition.waitMs` は非推奨で、TUI では無視されますが、互換性のために保持されています。print モードは上記のとおり引き続き使用します。インライン数式は同期的に segments を返してください。

### コマンドのエコー表示

コマンドは、デフォルトでは入力したスラッシュコマンドの行を会話記録にエコー表示します。たとえば `/btw <question>` などでこの行を省略するには、`api.registerCommand()` に渡す `CommandDefinition` に `echo: false` を設定します。全画面 TUI に適用されます。非表示になるのはフロントエンドのエコーだけです。コマンド自身の出力（`ctx.print`、通知、ビュー）は通常どおり表示され、入力履歴（↑）にも行が記録されます。print モードと RPC の動作は変わりません。

### 全画面ビューとドック表示のビュー

`api.registerView()` で `ViewDefinition` を登録し、コマンドから `ctx.openView?.({ kind, data, state })` で開きます。初期状態の `Partial<UiState>` は任意です。ビューは構造化された `ViewLine` オブジェクトを返します。端末、折り返し、スクロール、質問、確認はフロントエンドが管理します。`subagent` 種別と `/agents` コマンドは、組み込みのエージェント拡張機能が登録します。この拡張機能がない場合、会話記録のブロックから子を開こうとすると、ライブビューが利用できないと報告されます。

端末が F6 を通知する場合、F6 は、デフォルトのビューを含む、すべてのビューと入力欄の間でフォーカスを切り替えます。設定可能な `view.focus` アクションのデフォルトは `["f6", "ctrl+tab"]` です。Ctrl+Tab は端末が通知する場合に使える別名ですが、Windows Terminal が横取りしたり、従来の端末が通常の Tab として通知したりする場合があります。F6 はこれらの Ctrl+Tab の問題を避けられますが、VS Code の統合ターミナルでは `terminal.integrated.commandsToSkipShell` に `workbench.action.focusNextPart` が含まれているため、デフォルトで F6 が横取りされます。VS Code の設定で `terminal.integrated.commandsToSkipShell` に `"-workbench.action.focusNextPart"` を追加するか、Amira の `view.focus` を端末が通知するキーに再割り当てしてください。Shift+Tab 単独は `view.focus` に割り当てられません。権限モードの切り替えとビュー内の逆方向の移動に予約されています。デフォルトのビューは引き続き Tab も使え、ヒントは F6 を表示せず `tab→input/view` のままです。`ViewDefinition.needsTab: true` を設定すると、Tab/Shift+Tab をウィジェット間の移動やビューのショートカットに使い、デフォルトのフォーカスヒントは Ctrl+Tab ではなく `f6→input/view` を表示します。ホストのフォーカス切り替えは Shift+Tab を使いません。組み込みのサブエージェントビューは、この設定を宣言しています。`/`、`i`、表示可能なキーの振り分け、Esc、フォーカスの表示は[拡張機能のビュー](keybindings.md#拡張機能のビュー)を参照してください。操作中のビュー内入力欄やプロンプトは、引き続き自身の入力を受け取ります。

`title(data, opts)` は、先頭行用に `string | ViewLine` を返します。文字列の場合はデフォルトの `◆` マーカーが付きます。意味を持つ `ViewLine` はタイトル全体を提供し、自動のマーカーは付きません。フロントエンドは、どちらの形式も使用可能なタイトルの幅に合わせて切り詰めます。`titleAside(data)` は、`2 of 5` など、右端に保持する短いテキストを追加します。

`ViewLine` は ANSI エスケープコードを使わない、意味に基づくコンテンツをサポートします。スタイルはフロントエンドが管理します。

- `{ kind: "segments", parts: ViewSegment[] }` は、スタイル付きのテキストを 1 行にまとめます。折り返さず、フロントエンドが切り詰めます。エクスポートされる `ViewSegment` 型は `{ text: string, kind: "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" }` です。
- `{ kind: "user-message", text: string, note?: string }` は、折り返し、背景、間隔も含めて、会話記録のユーザーメッセージと同様に描画します。メッセージのテキストだけを指定し、自分で `›` マーカーを追加しないでください。任意の note は、同じ帯の中でメッセージの下に表示されます。

`ViewRenderOptions.statusBadge?(state: AgentStatusState, options?: { pad?: boolean }): ViewSegment[]` は、ホストが提供するエージェントの状態バッジ用ヘルパーです。`UiContext` は `ViewRenderOptions` を通じてこれを継承するため、宣言的なビューでも利用できます。`@amira/api` からエクスポートされる `AgentStatusState` 型は、`queued`、`working`、`idle`、`paused`、`done`、`failed`、`stopped` を受け付けます。テーマの記号、ASCII 表示、共通スピナーのタイミングと再描画はホストが管理します。queued は暗く、working はアクセント色、idle は控えめな色、done は成功色、failed はエラー色、stopped と paused は警告色で表示します（[状態バッジの凡例](subagents.md#状態バッジの凡例)を参照してください）。

返されたセグメントを、意味に基づく行に直接挿入します。たとえば、ビューのタイトルに使えます。

```ts
import type { ViewLine, ViewRenderOptions, ViewSegment } from "@amira/api"

function taskTitle(opts: ViewRenderOptions): ViewLine {
  const fallback: ViewSegment[] = [{ kind: "accent", text: "working" }]
  return {
    kind: "segments",
    parts: [
      ...(opts.statusBadge?.("working", { pad: true }) ?? fallback),
      { kind: "text", text: " Task" },
    ],
  }
}
```

`AGENT_STATUS_BADGES` は `AgentStatusState` をキーとする、エクスポートされた表示テーブルです。各項目の `{ symbol, ascii, role, label }` は、既定の Unicode 記号、ASCII 代替記号、意味に基づくテーマの役割、明確な状態語を表します。たとえば `AGENT_STATUS_BADGES.stopped` は `{ symbol: "‖", ascii: "|", role: "warning", label: "stopped" }` です。ホストのヘルパーはテーマの上書きとアニメーションも適用します。`{ pad: true }` は状態語を七セルに揃え、タスク名を同じ列から表示します。既定では揃えません。

早期終了の note を保持するため、`agent.status` だけでなく info/result 全体を `agentStatusState(agent)` に渡してください。エクスポートされた `AgentStatusSource` 型は、従来の状態文字列と会話ツリーのノードにも対応します。共通のマッパーは `done` と定義済みの早期終了 `note`（空文字列も含む）を `stopped` と解釈し、実行中のユーザーによる一時停止は `paused` と表示して `working` には数えません。ライフサイクルの結果契約は変更しません。拡張機能で行を揃える場合は `opts.statusBadge?.(agentStatusState(agent), { pad: true })` を呼びます。この関数やテーブルの名前付きインポートには、それらをエクスポートするホストビルドが必要です。任意のヘルパーはメソッドがないフロントエンドでの呼び出しを保護するだけで、存在しない名前付きインポートを互換にするものではありません。古いホストビルドもサポートする場合は、下例の名前空間インポートと機能検出を使ってください。これらの機能は API 0.1.48 から利用できます。引き続き機能検出を推奨します。

```ts
import * as amira from "@amira/api"

function displayState(status: amira.SubagentState, note?: string, paused = false) {
  if (typeof amira.agentStatusState === "function") {
    try {
      if (amira.agentStatusState({ status: "done", note: "" }) === "stopped")
        return amira.agentStatusState({ status, note, paused })
    } catch {} // An older host may accept only strings.
  }
  if (status === "done" && note !== undefined) return "stopped"
  if (status === "running" && paused) return "paused"
  if (typeof amira.agentStatusState === "function") return amira.agentStatusState(status)
  return status === "running" ? "working" : status === "error" ? "failed" : status === "aborted" ? "stopped" : status
}
```
`ctx.ui.choose()` は、選択肢と同じ順序の `optionStatuses?: (AgentStatusState | undefined)[]` も受け付けます。ホストは各選択肢の先頭に同じバッジを表示し、回答の文字列は変更しません。選択画面を開いたまま状態の変化を反映するには、ホスト内だけで実行する `live()` コールバックから `{ optionLabels?, optionStatuses?, descriptions? }` を返します。表示配列は元の選択肢と同じ順序です。`optionLabels` は表示用テキストで、元の `options` が安定した回答識別子になります。表示の変更は同じ `requestId` の `ui.request` として通知されます。フロントエンドと RPC クライアントは既存のリクエストをその場で更新し、選択画面を重複して開いたり、選択・フィルター・スクロールをリセットしたりしてはいけません。コールバックはシリアライズされず、リクエストが閉じると購読は解除されます。

キーには、印字可能な 1 文字、または `left`、`right`、`tab`、`shift-tab` を指定できます。同じラベルを持つキーは、フッターの 1 項目（`←→ switch`）にまとめられます。空のラベルを指定すると、別名などのキーをフッターに表示しません。Esc、q、Ctrl+C、スクロール用のキーは、引き続きフロントエンドが管理します。ハンドラーは `ViewControl` を受け取り、閉じる、再描画を要求する、`print(text, level?)` でスナップショットを出力する、質問する、確認する操作を行えます。出力にはコマンドの出力レベル（`info`、`warning`、`error`）を使用します。すぐに会話へ戻るには、先にビューを閉じてください。

`scrollKey(data)` を使い、選択した子やタブの id を返します。フロントエンドは、ビューが閉じるまで、id ごとのスクロール位置と追従状態を保持します。これを指定しない場合、ビューのスクロール状態は 1 つです。`follow: false` は、新しい id ごとに先頭から表示を開始します。

`api.session()` で現在のスナップショットを読み取り、`api.on()` でイベントを購読します。状態が変わったら `api.requestRender()` を呼び出してください。静的なビューには更新タイマーがありません。時間によって表示が変わる場合だけ、描画コールバックで `opts.requestRefresh?.(1000)`（宣言的なビューでは `ctx.requestRefresh`）を呼んでください。同じフレームで要求された正の有限間隔のうち最短のものを使います。要求はフレームごとにリセットされ、更新もアニメーションも要求されなければタイマーは停止します。覆われたドックや高さゼロのドックでは要求を一時停止し、再び表示されたときに再計算します。静的またはクリップされた選択画面やコマンド行では時計を動かさず、表示状態が working に変わると再開します。working バッジと実行中のツールは共通スピナーの周期を自動的に要求します。`header` と `render` は、使用可能な幅、現在時刻、任意の `renderTool(toolName, call, detail)` コールバックを受け取ります。このコールバックは、ホストの現在のツール表示処理とフォールバックレンダラーを使用します。ホストの表示を維持するには、`ToolCallView` を渡し、結果の行を変更せずに返してください。他のフロントエンドでは省略される場合があるため、通常の行によるフォールバックを用意してください。これらのビュー機能は API バージョン 0.1.15 で追加されました。

D105 では、別のビューを登録せずに、ホストが管理するページを使用できます。`view.pushPage({ title?, state?, data? })` と `view.popPage()` を呼び出します。描画コンテキストと UI コンテキストには、追加されたページ上で `page: { depth, data? }` が公開されます（depth は 1 から始まります）。ルートでは省略されます。ビューの元のデータは、コールバックの第 1 引数のままです。任意のページタイトルは、従来のタイトルを置き換えるか、宣言的なコンテンツの上にタイトル行を追加します。各ページは、選択、展開、タブ、入力、フォーカス、スクロール状態を独立して持ち、従来の `scrollKey` の位置も含みます。ページを戻ると前のページの状態が復元されます。Esc はまず開いている質問をキャンセルし、それ以外ではページを戻り、ルートではビューを閉じます。ホストのキーバーには、ページ上で `Esc back`、ルートで `Esc close` と表示されます。Ctrl+C は、質問や確認の途中でも常にビュー全体を閉じます。q の動作は変わりません。ページ遷移は、回答待ちの質問をキャンセルします。

任意の `onOpen(data, control)` と `onClose(data)` フックは、開く・閉じる操作ごとに 1 回実行され、再描画やページ変更では実行されません。初期状態は `onOpen` より前に適用され、`onOpen` は `setState` または `close` を呼び出せます。同じ拡張機能インスタンスの同じ登録から、表示中の同じ種別を開くと、閉じて開き直すことなくデータを置き換えます。初期状態を明示的に指定しない限り状態は保持されます。指定した場合は、新しいルートページを開始します。別の種別や別の拡張機能インスタンスで置き換えると、前のビューを閉じて新しいビューアーを作成します。開いた拡張機能か、ビューを提供する拡張機能のどちらかがアンロードされると、登録を削除する前に、そのドックと全画面ビューを閉じます。保持しているコマンドコンテキストから、アンロード後にビューを再び開くことはできません。

### 補助的な質問: 一時的なエージェント、ドック、表示ブロック

`SpawnOptions.ephemeral?: boolean` は、メモリ内の子を作成します。`persistent: false` を渡しても、自動的に永続的な子として扱います。その `ChildSession` を保持し、追加の質問には `send(text)` を使用してください。`stop()` は現在のターンが終わってから終了し、`abort()` は直ちに停止します。親の終了や切り替えでも中止されます。この子とその子孫には、セッションやアーティファクトのファイル、親の `subagent` エントリ、公開の一覧、メインの会話記録のイベントがありません。代わりに `child.events` を購読してください。使用量はエージェントツリーに計上され、`api.complete` と同様に所有者の `side_usage` として保存されます（所有者が初めてセッションを書き込むまでバッファリングします）。スキーマに基づく結果は、一時的・永続的な子とは併用できません。

`SpawnOptions.callableTools?: string[]` は、ローカルの宣言を削除したり並べ替えたりせずに、ローカルでの実行を制限します。拒否されたローカル呼び出しは、実行や承認の前に短いツールエラーを返します。プロバイダーがホストするツールはリモートで実行されるため、除外されたものはローカルエラーを返すのではなく、**リクエストされません**。OpenAI Responses、Anthropic、Gemini の組み込みホスト型検索は、移植可能な名前 `web_search` を使用します（Gemini の Google Search も含みます）。許可するには、この名前を追加してください。一覧を省略すると、ツールは制限されません。この制限は、子の圧縮リクエストと、承認・質問に関する相談にも適用されます。子孫は、継承した呼び出し権限を広げられません。

フォークの**ローカル**ツール宣言を維持するには、`tools`/`excludeTools` ではなく `callableTools` を使用します。一時的な子は `mainOnly` の宣言を保持しますが、呼び出せません。フォークは、読み込み済みの遅延ツールを親の順序でコピーします。未読み込みの遅延ツールは引き続き提示されません。ホスト型検索を除外すると、その宣言が削除され、継承したホスト型の結果がテキストに変わることがあります。そのため、リクエスト・キャッシュのプレフィックス全体は、その検索を提示する親と同一ではなくなります。役割の指示、セッションごとのインターセプター、異なるモデル、子専用のツール、未完了の親の呼び出しの削除も、プレフィックスを変える場合があります。

一時的な処理でも、**`maxConcurrent`**、深さ、グループの制限、トークン・コストの予算を**回避できません**。ツリー全体の上限が 2 以上なら、通常の子が占有できる実行中のスロットは最大 `maxConcurrent - 1` で、一時的な処理の初回または追加のターン用に 1 つを予約します。一時的な処理は、他の空きスロットも使えますが、全体の上限やグループの上限を超えることはありません。`maxConcurrent: 1` の場合は通常どおりキューに入ります。開始時の待機状態を表示するには、生成直後に `child.state === "queued"` を確認してください。最初の `subagent.start` イベントは `spawn()` が戻る前に発行され、新しい購読者には再送されません。キューに入った追加ターンも含む、その後の `subagent.state` の変更には `child.events` を購読してください。アイドル状態の子は実行枠を解放します。失敗した試行や再試行を含む相談の使用量は、相談に使ったモデルの識別子とともに、要求元の一時的な子の `side_usage` として保存されます。

ドックは `ctx.openView?.({ kind, data, placement: "dock", maxHeight?: number })` で開きます。全画面の場合は `placement` を省略します。高さにはタイトル・ヘッダー・フッターが含まれ、デフォルト値は使用可能な端末行数の 40% です。入力欄によって空きが少なくなる場合を除き、最小は 5 行です。TUI は、テーマと余白に対応したライブドックを、フォーカス中の入力欄のすぐ上に表示します。設定した `scroll.page-up`/`scroll.page-down` キー（デフォルトでは PgUp/PgDn）でスクロールし、ホイールはドック上にあるときだけドックをスクロールします。`scroll.bottom`（デフォルトでは End）で新しい出力に追従します。ドックは入力欄にフォーカスした状態で開きます。選択可能な内容があれば F6 でドックへ移動します（Ctrl+Tab は端末が通知する場合に使える別名です）。`needsTab: true` でなければ Tab も使えます。ドックにフォーカスがある間は、ウィジェットや拡張機能のショートカットが対応するキーを受け取ります。読み取り専用のドックは、フォーカスを取らず従来のスクロール動作を維持します。ドックの `prompt`/`confirm` は、入力欄を置き換えるのではなくキャンセルされます。ドックにフォーカスがある場合、Esc は戻るか閉じます。入力欄が空なら、全画面ビューと同様に、Esc は選択可能なドックへフォーカスを戻します。入力欄にテキストがある場合、Esc は従来どおりドックを閉じ、下書きを保持します。履歴検索が優先され、Esc は先に検索をキャンセルして下書きを戻します。入力欄が空なら、次の Esc でビューや選択可能なドックへ戻ります。読み取り専用のドックは、引き続きコマンドのキャンセルやターンの中断より先に閉じます。ダイアログの表示中は、ドック上のホイールスクロールだけが可能で、クリックしてもドックへのフォーカス移動や内容の選択は行いません。上を覆う全画面のフォームやビューは、通常のキー優先順位を保持します。`follow`、Markdown 用の `renderReply`、`onClose` は、全画面ビューと同じように動作します。

`ctx.print(text, level?, { details?: string; markdown?: boolean; persist?: boolean })` と `api.notify(text, level?, options?)` は、表示専用のブロックを出力します。見出し部分は `text` です。details は要約表示では折りたたまれ、詳細表示（Ctrl+O）では展開されます。`markdown: true` は details を Markdown として描画します。`persist: true` は `display` セッションエントリを保存し、再開時に会話記録の順序で復元しますが、コンテキスト構築ではスキップします。見出しも details も、セッションのフォーク、サブエージェントのフォーク、圧縮を含め、モデルに届くことはありません。表示専用のセッションも、起動時の再開で描画されます。保持した `ctx.print` は、セッションの切り替え中にドックが閉じても、そのコマンドを実行したセッションに紐づいたままです。TUI は折りたためるブロックを保持します。print モードは見出し部分を出力し、RPC は任意の詳細フィールドも渡します。

次の `/btw` 形式の例は、公開 API だけを使用します。これは説明用のコードで、同梱される拡張機能ではありません。実運用の拡張機能では、子の終了、追加メッセージの配信失敗、アンロード時のクリーンアップにも対応してください。

```ts
import { defineExtension, type ChildSession, type SpawnGroup, type CommandContext } from "@amira/api"
export default defineExtension((api) => {
  type Side = { question: string; answer: string; child: ChildSession; group: SpawnGroup; print: CommandContext["print"] }
  let side: Side | undefined
  api.registerView({
    kind: "btw", title: (d: Side) => `btw: ${d.question}${d.child.state === "queued" ? " (waiting)" : ""}`, follow: true,
    render: (d: Side, opts) => opts.renderReply?.(d.answer) ?? [{ kind: "text", text: d.answer }],
    onClose(d: Side) { d.child.abort(); d.group.end()
      if (side !== d) return
      side = undefined
      d.print(`btw: ${d.question}`, "info", { details: d.answer, markdown: true, persist: true })
    },
  })
  api.on("session.end", () => { side?.child.abort(); side?.group.end(); side = undefined })
  api.registerCommand({
    name: "btw", description: "Ask a side question", echo: false,
    run(question, ctx) {
      if (side) { side.answer += `\n\nFollow-up: ${question}\n\n`; side.child.send(question); return }
      if (!ctx.openView || !ctx.session.createGroup) throw new Error("Side questions need the TUI and an agent tree")
      const group = ctx.session.createGroup({ name: "Side question" })
      const child = group.spawn({ prompt: question, context: "fork", ephemeral: true, callableTools: ["read", "grep", "glob"], systemPrompt: "Answer this side question; do not change files." })
      const d: Side = { question, answer: "", child, group, print: ctx.print }; side = d
      void (async () => {
        for await (const e of child.events) {
          if (e.type === "message.delta" && e.data.kind === "text") { d.answer += e.data.text; api.requestRender() }
        }
      })().catch((error) => api.reportError(String(error)))
      if (!ctx.openView({ kind: "btw", data: d, placement: "dock" })) { side = undefined; child.abort(); group.end() }
    } })
})
```

### 拡張機能が所有する永続的な会話

`api.conversations?: OwnedConversations` は任意のホスト機能です。利用可能か確認してください。保存済みの履歴を約束しながら、一時的な子で代用してはいけません。`/btw` 形式の子と異なり、owned conversation は安定した owner/key、独立した保存セッション、単一ライターのリースを持ちます。現在のメインセッションではなく拡張機能に属し、メインの `/clear`、`/resume`、巻き戻し、フォークでも停止や再バインドされません。ビューを閉じる操作は表示を隠すだけです。TUI では同じネイティブの会話記録と入力欄でこの会話にフォーカスでき、メインセッションはバックグラウンドで処理を続けます。

- `openOrCreate(spec, runtime): Promise<OwnedConversation>` は所有者の保存済み key を開くか、新しく作成します。`open(id, runtime)` はその拡張機能が所有する会話だけを開きます。別のホストやプロセスがリースを保持していれば、明確な **in use** エラーになります。同じ拡張機能インスタンスからの再オープンは、既存のハンドルを返します。
- `read(ref: OwnedConversationRef): Promise<OwnedConversationSnapshot | undefined>` は、所有者の範囲内の `{ id }` または `{ key }` で読み取り、実行可能なハンドルを開きません。このマネージャーにアクティブなハンドルがあれば、その権威あるライブ状態を使用し、なければ検証済みの永続化データを使用します。別プロセスのライターがある場合、永続化スナップショットは遅れる可能性があり、不完全とマークされます。本当に存在しない記録だけが `undefined` になり、不正な識別子や別所有者の識別子は例外になります。設定済みモデル、実行時ツール、現存する cwd は不要で、agent の構築、モデル検索、実行時の再バインド、書き込みリースの取得、フォーカス変更、ディレクトリ修復、プロバイダーへのリクエストは行いません。
- `ConversationSpec` は `key`、`name`、絶対パスの `cwd`、任意の `model`（`provider/model`）、`systemPrompt`、必須の `callableTools: string[]` を含みます。ホストはこの仕様を保存します。再オープンで仕様や権限を暗黙に変更・拡張できません。通常のメインセッションの一覧、resume、fork とは別に保存されます。
- `ConversationRuntime` は必須の `askUser(questions, { sessionId, signal }): Promise<AskAnswer[] | undefined>` と任意の `extraTools: ToolDefinition[]` を含みます。再オープン時にはコールバックと実行関数を再バインドしてください。これらはシリアライズされません。必要なツールがなければ実行を拒否します。質問はこのコールバックに直接届き、メインのモデルが回答することはありません。人が選べる UI を表示し、キャンセルに対応し、必要な決定の証拠は回答を返す前に保存してください。`undefined` はキャンセルを意味します。
- 作成や再オープンでは、モデルへのリクエスト、未完了ターンの再実行、子タスクや質問の復元は発生しません。拡張機能の初期化中も会話を開けますが、owned `send()`、`runTool()`、`complete()`、`createGroup()` は初期化が完了するまで拒否されます。処理は初期化後のコマンドまたは `session.start` ハンドラーで開始してください。初期化関数内で準備完了を待つと、起動がデッドロックします。明示的な `OwnedConversation.send(text, { images?: ImageBlock[], display?: MessageDisplay, signal? })` だけがターンを開始し、画像だけを送る場合はテキストを空にできます。ターンの終了時に完了し、send/tool/complete の重複実行は拒否されます。設定済みの AI/プロバイダーとホストの制限が引き続き適用されます。
- 保存した callable allowlist は承認前にローカル実行を制限し、禁止されたホスト型ツールを圧縮も含むプロバイダーのリクエストから除外します。`createGroup(options)` はこの会話に紐づきます。子孫の権限は継承した集合との共通部分に限られ、shell ツールや worktree は使用できません。許可したツール名の実装は信頼する必要があります。拡張機能コードを隔離するサンドボックスではありません。
- `complete(request: Omit<CompleteRequest, "model">): Promise<CompleteResult>` は、保存済みモデルで論理的に 1 回のテキスト専用サイドリクエストを行います。別モデルには、そのモデルの owned conversation を別途作成してください。ツールやホスト型検索を使わず、会話履歴を注入せず、履歴にモデルターンを追加しません。操作/label の出所は別途保存します。再試行、エラー、中止を含む報告済みの全試行がこの所有者と `usage()` に計上され、返された内容を拒否しても変わりません。未報告の使用量は不明のままで、料金を推測しません。初期化中や `send`、`runTool`、別の `complete` との重複実行は拒否し、共有の実行枠とグローバル制限に従います。`stop`、`release`、拡張機能のアンロードはキャンセル後に実際の終了を待ちます。
- `usage(): ConversationUsageSnapshot` は累積会計を返し、履歴メッセージの使用量の合計ではありません。`own` はこのセッション分、`total` は帰属が確認できる子孫をそれぞれ 1 回だけ含みます。子孫の行はそのセッション自身の使用量で、サブツリー合計ではありません。これらの行や runner/group の合計を `total` に再加算しないでください。報告済みの再試行、失敗した試行を含む圧縮、サイドリクエスト、相談、中止した処理、遅れて届く使用量も計上します。非公開の子孫は履歴なしで行を持てます。古い匿名の使用量記録は、永続化先の所有者の `own` に残し、子の識別子を作り上げません。
- 使用量と読み取りのスナップショットは、深く凍結され、シリアライズ可能です。各 `AccountedUsage` は `usage.cost` がなくても既知の料金小計 `knownCostUsd` を保持します。`Usage.pricingUnknown` と `complete: false` は、価格や会計の網羅性が不足していることを保持します。未永続化の料金も表示されますが不完全です。証拠の欠落や破損を確認済みのゼロ料金として扱いません。`complete` は報告済み会計/価格の網羅性であり、プロバイダーの請求書全体を保証しません。`revision` は永続化される会計リビジョンで、イベントの連番ではありません。符号付き訂正で合計が減ることがあるため、最大料金ではなくリビジョンで古いスナップショットを置き換えてください。子/group の終了後にも使用量が更新されることがあります。
- `complete` は保守的に判定します。計上対象のすべての物理的な試行に明示的かつ永続化された完全な網羅性の証拠があり、すべての子孫参照を解決でき、未完了のリクエストフェンスがない場合にのみ完全と認定します。価格がある小計だけでは証明になりません。証拠の欠落、不正な形式、未報告、未定価、未照合があれば不完全のままです。十分な証拠のない古い記録も完全とは認定しません。報告済みの小計を持つ明示的な置換集計は、金額が変わらず網羅性だけが変化する場合も、以前の会計状態を置き換えます。終端記録で任意のメタデータが単に省略された場合は、既知の金額を保持し、網羅性は不完全とします。読み取りは証拠を検証するだけで、修復や書き込みはしません。
- v1 は、残存するリクエストフェンスと使用量記録の証拠を使い、プロセスのクラッシュ、途中/部分書き込み、末尾の切り詰め、使用量記録の欠落に対応します。改ざんを検出する監査ログではありません。途中の取引を含む、完全な会計取引の意図的な削除は保証の対象外です。新しい読み取りプロセスは、整合性を保った取引単位の削除を検出できないため、`complete: true` は会話ファイルが一度も改変されていないことを証明しません。
- `budget.update`、関連する完了イベント、`events.lost` は会計キャッシュの無効化にだけ使い、その後 `usage()` を呼びます。共有の累積予算ペイロードを所有者の台帳として扱わないでください。スナップショットの前に購読し、release 前と処理終了待ちの後に更新し、release や再起動後は `read()` で照合します。プロジェクト/段階への帰属と停止ポリシーは拡張機能が管理します。報告済み料金による停止は進行中の処理で超過する可能性があり、請求額の上限や共有ホスト予算の分離を保証しません。
- ハンドルには `id`、`key`、`name`、`cwd`、紐づいた `data: SessionData`、`history()`（圧縮で置き換えられたメッセージも含む現在の完全なブランチの不変スナップショット）、`status()`（state と busy）、`events: AsyncIterable<AnyEvent>` があります。`OwnedConversation.events` はこの会話と通常の子孫のイベントを含み、それぞれの sessionId を持ち、メインの会話バスには流れません。一時的な子孫は専用バスを保持するため、拡張機能はその `ChildSession.events` を使用してください。履歴・状態のスナップショットを読む前に購読してください。イベントは再送されません。保存メッセージの復元には history を使い、ツール行は session/turn/tool-call id で対応づけます。
- 紐づいた `SessionData.append(key, data): void` は永続書き込みの確認を返しません。ディスク障害は `extension.error` として非同期に報告され、`append()` から戻っても永続的なコミットは保証されません。決定の証拠に永続的なコミットが必要な場合は、`askUser` の質問に回答する前に、拡張機能が管理するストレージへコミットしてください。
- `stop(reason?): Promise<void>` は処理、未回答の質問、子孫を中止し、履歴を残します。その後の明示的な send で継続できます。`release(): Promise<void>` は停止とクリーンアップを待ち、リースを解放してハンドルを無効にします。履歴は削除せず、繰り返し呼び出せます。所有する拡張機能のアンロード・無効化とホスト終了時は、ホストが清掃を管理します。メインやその子を中止することはありません。archive/unarchive や削除の API はありません。`release()` は会話をアーカイブせず、アンロードやパッケージ削除後も履歴は残ります。`OwnedConversationSnapshot.archived` は現在常に `false` です。

公開スナップショット型は次のとおりです。

```ts
type OwnedConversationRef = { id: string } | { key: string }

interface AccountedUsage {
  usage: Usage
  knownCostUsd: number
  complete: boolean
}

interface ConversationUsageSnapshot {
  sessionId: string
  revision: number
  own: AccountedUsage
  total: AccountedUsage
  descendants: readonly {
    sessionId: string
    parentSessionId: string
    groupId?: string
    ephemeral?: boolean
    usage: AccountedUsage
  }[]
}

interface OwnedConversationSnapshot {
  id: string
  key: string
  name: string
  cwd: string
  archived: boolean
  history: readonly Message[]
  usage: ConversationUsageSnapshot
}
```

`CommandContext.focusConversation?(owned: OwnedConversation): boolean` は所有する会話にフォーカスし、`unfocusConversation?(): boolean` はメインへ戻ります。両メソッドの有無を確認してください。全画面 TUI だけで利用でき、切り替えできない場合は `false` を返します（解放済みハンドルへのフォーカスも失敗します）。フォーカスや復帰は処理を停止せず、どちらの会話も解放しません。フォーカス中のハンドルを解放するか、所有する拡張機能をアンロードするとメインへ戻ります。レンダラーの保持制御はホスト内部の実装であり、公開拡張 API ではありません。

フォーカス表示には会話名、メインの `working`/`idle` 状態、メインの未回答の質問が表示されます。メインの要対応表示は、全画面オーバーレイの内容の上または下に確保した UI 領域に表示され続けます。入力欄のプレースホルダーは `Message <owned name>` で送信先の会話名を示します。F6（設定済みの `view.focus` 割り当て）でメインへ戻ります。フォーカス中の会話が待機中で入力欄が空なら Esc でも戻れます。実行中の Esc/Ctrl+C はフォーカス中の会話だけを停止し、メインは停止しません。ダイアログ、補完一覧、履歴検索のキー優先順位は変わりません。下書き、プロンプト履歴、画像添付、貼り付け内容は会話ごとに保持し、`@` のファイル補完はその会話の `cwd` を使います。フォーカスの切り替え時には元の下書きを保存して切り替え先の下書きを復元しますが、編集バッファー全体（undo/redo 履歴、kill ring、yank 状態と、そこに保持された画像・貼り付けのスナップショット）をリセットします。通常の `setParts` の動作は変わりません。スラッシュコマンドとスキルは実行せず、メインへ戻るようヒントを表示します。入力は保持され、メインで明示的に実行する必要があります。

切り替え時は、履歴検索をキャンセルしてから元の下書きを保存します。未完了のブラケット付き貼り付けは入力の所有者が変わる時点で破棄し、タイムアウト後も終了マーカーまで残りのバイトを隔離します。owned conversation のフォーカス中は、遅延した Esc の二度押しや保持した `openRewind()` 呼び出しを含むメインの巻き戻し要求を待機させ、フォーカス表示にメインの保留状態を示します。メインに戻って準備が整った後に選択画面を開き、復元したプロンプトはメインの下書きだけに入れます。

コマンド、skill、入力ハンドラーの `openView()` は、コンテキスト作成時の会話に関連付けられます。遅延した表示要求は、別の会話がフォーカス中、または元のメインセッションが置き換わった場合に `false` を返し、現在の会話記録や入力を奪いません。フォーカス変更では未回答の質問エディターをキャンセルせず一時停止し、戻ると未完成の回答、選択、カーソル位置を復元します。回答またはキャンセル時に保存した編集状態を解放します。

会話の切り替えでは `— design: <name> —` または `— main —` を表示し、所有する会話名を使い、生の ID は表示しません。非表示中に保留した新しい出力は、戻ったときに表示できます。TUI はフォーカス中の会話の保存済み記録を表示します。

`UiRequestOptions.sessionId?: string` は UI リクエストを会話に関連付け（デフォルトはホストのセッション）、表示と会話単位の承認キャンセルに使います。実行の所有者や権限は変更しません。承認のキャンセルは関連付けられた会話だけを停止し、無関係なメインやフォーカス中の会話は停止しません。すべての UI リクエスト種別で、RPC のライブ/再送の `ui.request` イベントと `state.uiRequests` は更新時もこの関連付けを保持します。`ui.resolved` と `ui.progress` はイベントエンベロープの `sessionId` に関連付けを保持します。RPC のトップレベルの `state.sessionId` はメインセッションの ID のままです。子孫のリクエストはメタデータに子の ID を保持し、ネイティブのホストが表示と承認キャンセルのために所有する会話へ対応付けます。フォーカス前から待機中のリクエストも対象です。runtime の `sessionId` と `signal` を `ctx.ui.ask` に渡し、対応する会話に質問を表示してください。

```ts
api.registerCommand({
  name: "notes", description: "Open saved notes",
  async run(_args, ctx) {
    if (!api.conversations) throw new Error("This host does not support saved extension conversations")
    const conversation = await api.conversations.openOrCreate({
      key: "notes", name: "Notes", cwd: api.cwd,
      systemPrompt: "Research and discuss notes. Ask the human before recording decisions.",
      callableTools: ["read", "grep", "glob", "ask_user"],
    }, {
      askUser: (questions, { sessionId, signal }) => ctx.ui.ask(questions, { sessionId, signal }),
    })
    if (!ctx.focusConversation?.(conversation)) ctx.print("Native conversation focus is unavailable")
  },
})
```

カスタムビューで、メインの入力欄を置き換えずに所有する会話を表示することもできます。メインの状態は `api.session()` から、この会話の記録と状態はハンドルから読みます。所有する会話の質問の `sessionId` を省略したり、表示できない場合に回答を推測したりしてはいけません。会話インターフェース、`api.conversations`、`ToolSession.restricted` は API 0.1.51 から、ネイティブフォーカスは API 0.1.52 から利用できます。古いホストでも正しく縮退できるよう、引き続き機能検出してください。`ConversationSpec.writeRoots`（ファイルツールの書き込み先の上限。OS サンドボックスではありません）、`descendants`（`"inherit"` で子エージェントがシェルと独自の cwd を使えます）、`OwnedConversation.runTool` は API 0.1.53 から利用できます。TypeScript の任意フィールドは機能検出にならず、古いホストは未知のフィールドを無視することがあるため、これらに依存する前にホストの API バージョンを確認してください。

### サブエージェントの制御

`@amira/api` から `subagentTranscriptText(info, messages, all, now?)` をインポートすると、子の会話記録を簡潔なプレーンテキストで描画できます。`/agents` と `/tasks` は、ライブビューを開けない場合にこれを使います。通知や追加メッセージがあっても子の元のタスク境界を保ち、ツール呼び出し、結果のプレビュー、最終回答の全文を含めます。書式設定とメッセージ選択のヘルパーは内部実装です。別の拡張機能や内部パッケージのサブパスからインポートしないでください。

`SessionControl.messageSubagent(id, text)` は、ユーザーが作成したメッセージを子孫に送ります。作業中なら次のモデル呼び出しに届き、アイドル状態の 永続的な子なら別のターンを開始し、キューに入っている子には実行が許可されたときだけ届きます。メッセージは、親モデルからの通知ではなく、ユーザーメッセージとして子の会話記録とバスのイベントに表示されます。不明な子、終了した子、停止中の子には false を返します。`pauseSubagent(id)` は、次のモデル呼び出しの前で待機させ、現在のモデル・ツールの処理は中止や結果の消失なしに完了させます。`resumeSubagent(id)` はこの待機を解除します。一時停止中の子は、`SubagentInfo.status` と `subagent.state` で `paused` を報告します。実行が許可された一時停止中の子は、ツリーとグループの実行枠を保持するため、一時停止しても別の子が使える並行実行枠は増えません。一時停止中も停止できます。一時停止は実行中の子だけに適用できます（キュー内やアイドル状態には適用できません）。pause/resume は、不明、終了済み、またはすでに要求した状態の場合に false を返します。この待機は、拡張機能のメッセージキュー（swarm の一時停止も含みます）とは独立しており、一方を再開しても他方は解除されません。

RPC クライアントは、`{ sessionId, text }` を渡して `subagent.message` を使い、`{ sessionId }` を渡して `subagent.pause` と `subagent.resume` を使います。応答には、それぞれ boolean の `delivered`、`paused`、`resumed` が含まれます。配信は受け付けられたことを意味し、モデルがすでに見たとは限りません。これらの追加で `API_VERSION` は変わりません。

### 宣言的なビューウィジェット（実験的）

D104 L3 では、`API_VERSION` を変更せずに、実験的な `ui(data, ctx): UiNode` の仕組みを `ViewDefinition` に追加しています。型は `@amira/api` からのみインポートしてください。TUI や tui-kit への依存は不要です。`ui` または既存の `render` を指定します。`ui` がある場合、タイトル、ヘッダー、行形式で描画する画面コンテンツを置き換えます。ウィンドウ表示・フォールバック表示用に `title` は引き続き必要です。`/agents` やジョブのビューを含め、既存の行のみのビューは現在の動作を維持します。

```ts
import type { ViewDefinition } from "@amira/api"

const review: ViewDefinition<{ messages: string[] }> = {
  kind: "review",
  title: () => "Review",
  ui: (data) => ({
    type: "column",
    children: [
      { node: { type: "text", id: "log", follow: true,
        lines: data.messages.map((text) => ({ kind: "text", text })) } },
      { size: 3, node: { type: "box", title: "Message the team",
        child: { type: "input", id: "message", placeholder: "Ask for a review…" } } },
    ],
  }),
  onEvent(event, data, view) {
    if (event.type === "submit") {
      data.messages.push(event.value)
      view.setState({ inputValues: { message: "" } })
    }
  },
}
api.registerView(review)
```

エクスポートされる `UiNode` の共用体は、`type` を判別子として使用します。すべてのコンテンツは意味に基づきます。色や生のエスケープシーケンスではなく、テキストと `ViewSegment` の意味を指定します。表示するすべての文字列は、タイトル、ラベル、セル、ヒント、入力値も含め、既存のビューの行とまったく同じようにサニタイズします。長い行は省略記号付きで切り詰め、テキスト行は既存の折り返しを維持します。テーマ、クリッピング、入力、端末はホストが管理します。

| ウィジェット | 内容とオプション |
| --- | --- |
| `column`, `row` | `children: { node, size?, min? }[]`、`gap?`、`divider?` |
| `box` | `child`、`title?: ViewLine \| string`、`aside?`、`border?: "round" \| "none"`、`tone?: "normal" \| "accent" \| "focus"` |
| `text` | `lines: ViewLine[]`、任意の `id`、`follow?`（デフォルトは false） |
| `tree` | `id`、`items: UiTreeItem[]`、任意の `expanded: "all"` |
| `tabs` | `id`、`tabs: { key, label, body }[]`、`style?: "brackets" \| "divided"`（デフォルトは `"brackets"`）。レイアウトされるのはアクティブな body だけです |
| `table` | 任意の `id`、`columns: { key, label, size?, align?: "left" \| "right" }[]`、`rows: { key, cells: Record<string, string \| ViewSegment[]> }[]` |
| `bar` | `left: ViewSegment[]`、任意の `right: ViewSegment[]` |
| `progress` | 0 から 1 の `value`（範囲内に制限）、任意のバーの最大 `width` と `label` |
| `rule` | 任意の `label` |
| `input` | `id`、任意の `placeholder`、`hint`、`activate?: string`（たとえば `"i"` または `"/"`）。box のタイトルなど、見えるラベルを使用してください |
| `spacer` | 任意の、セル単位のデフォルトの主軸方向の `size` |

`Size` は `number | \`${number}%\` | "fill"` です。固定のセル数、gap と divider を除いた主軸方向の割り当て可能な領域に対する割合、または残りの領域の均等な分配を表します。サイズの省略は fill を意味します（spacer に明示したサイズを除きます）。各 divider は `gap` に加えて 1 セルを使用します。実現可能な最小値を確保してから、超過した要求を比例的に縮小します。最小値そのものは、その合計が収まらない場合にだけ縮小し、ソース順にセル数を丸めます。矩形のサイズが負になることはなく、box の枠線は幅 8 列未満、または高さ 3 行未満で非表示になります。table のヘッダーとセルは、1 セルの間隔を持つ共通の列割り当てを使用します。狭い端末で別の構成を選ぶには、`ctx.width` を使ってください。

`UiTreeItem` は、安定した `key`、意味に基づく `row`、任意の意味に基づく `aside`、`detail: ViewLine[] | UiNode`、`children`、`rail`、`expandable` を持ちます。詳細は、展開中だけ、行の下で子の前に表示されます。ウィジェットの詳細は、ツリーの接続線・インデントの内側で残りの幅に収まり、コンテンツの高さを使用します。テキストは折り返され、table はヘッダーと行を含み、box は枠線を追加し、row は最も高い子に合わせ、column は子の高さに gap と divider を足した合計になります。column の子に指定した数値のサイズと最小値は適用されます。省略・fill・割合の高さは、固定の縦方向の領域がないため、コンテンツの高さを使用します。row の幅は通常の `Size` の割り当てを使用します。詳細でサポートするウィジェットは、`box`（title、aside、border、tone を含む）、`row`、`column`、`text`、`progress`、`bar`、`rule`、`table`、空白の `spacer` です。これらは表示専用です。ID と `follow` は無視され、フォーカスやホイール入力を受け取ることはなく、入れ子の tree/tabs/input ウィジェットは描画されません。フォーカスは tree に留まり、select/activate イベントは引き続き tree の項目キーを渡します。ワーカーのカードには、tree 項目の detail を使ってください。`expandable: true` は、子の読み込み前に展開用の表示を出します。toggle を処理して子を読み込んでください。tree ノードに `expanded: "all"` を設定しない限り、tree は折りたたまれた状態で開始します。このデフォルト値は新しい行にも適用しますが、明示的な初期状態・setState による展開やユーザーの切り替えが優先されます。そのため、折りたたんだ行は再描画やページの復元後も折りたたまれたままです。

タイムラインの行には `lead?: ViewSegment[]`、`gap?: number`、`node?: ViewSegment[]`、`underline?: boolean` を追加できます。`gap` は lead の後の間隔をセル単位で設定します（デフォルトは 1）。lead は、フォーカスマーカーの後、接続線の前に置く共通の固定幅の列です。現在表示されている（折りたたまれていない）項目の gap も含めてサイズを決め、行の余地を残すよう上限を設けます。lead のない行、すべての詳細行、下線の行にも同じ列を確保します。時刻やステータスマークに使用してください。`node` は、行上の展開表示・接続線用の 2 セルの領域を置き換えます（たとえば `○` や `◉`）。その領域に合わせて切り詰め・埋め合わせを行います。Left/Right は引き続き折りたたみ・展開を行います。`rail: true` は、詳細や下線の横に `│` を続け、子を `├─`/`└─` でつなぎます。lead も node も、暗黙には接続線を有効にしません。`underline` は、展開した詳細の後（折りたたまれた行の場合は行の直後）、子の前に細い罫線を追加し、接続線がインデント部分を通過します。

小さな意味付きラベルには、`ViewSegment` を受け付ける場所で `{ kind: "chip", text: "TypeScript", tone: "info" }` を使用できます。tone は任意で、デフォルト値は `"neutral"`、選択肢は `"neutral" | "info" | "success" | "warning" | "danger" | "accent"` です。ホストが色を選び、背景色の半ブロックを両端に使って `▐text▌` を描画します。モノクロ、プレーンテキスト出力、chip 用トークンのないテーマでは `▏text▕` を使用します。ラベルは他のセグメントと同様にサニタイズして切り詰めます。既存のプレーンテキスト・print の処理経路は引き続きサポートします。print モードは対話型のビューを開きません。

タブのデフォルト値は `style: "brackets"` です。`style: "divided"` では、区切り線でラベルを分けます。選択したラベルは、カラーではアクセントの背景と太字、モノクロでは角括弧で表示します。

`ViewDefinition.hostKeys?: "full" | "minimal" | "none"` は、ホストのキーバーを制御します。デフォルト値は `"full"` です。`"minimal"` は `Esc back` または `Esc close` だけを表示し、`"none"` は Esc を無効にせずフッター行を取り除きます。質問と確認は、どのモードでも表示されます。

`activate` を持つ input は、自動的にキーボード入力を受け取りません。操作開始キーを押して入力に入ります。プレースホルダーには操作開始のヒントが表示されます。明示的な `view.focus(id)` と、`needsTab: true` の場合は Tab による移動も使用できます。Esc は、ページを戻ったりビューを閉じたりする前に、操作中の input から離れます。`activate` を省略すると、入力欄への自動フォーカスを維持します。

`UiContext` は、ホストが保持する `state: UiState` と `height` を `ViewRenderOptions` に追加します。height は、待機バナー、ホストのキーバー、追加されたページのタイトルを除いた、本文に使用できる行数です。負にはならず、リサイズ時に更新されます。マップのキーには、ビュー全体で一意の安定したウィジェット ID を使います。`selected` は tree/table の項目キー、`expanded` は tree 項目キーの配列、`activeTabs` はタブのキー、`scroll` は `{ top, following }`、`inputValues` は文字列を保持します。`focused` は任意のウィジェット ID です。ビューが閉じるまで、再描画、同じ種別のデータ置き換え、非アクティブなタブでも状態を保持します。選択項目やタブが見つからない場合は、最初の見える項目やタブにフォールバックします。フォーカスがない場合は、入力の操作開始を必要としない、最初の見えるウィジェットにフォールバックします。コンテキストの状態は読み取り専用として扱い、`ui` に副作用を持たせないでください。ホストは、選択、タブ、フォーカスを修復した後、依存する詳細が操作項目と一致するよう、同じフレーム内で再構築することがあります。コンテンツが安定しない場合は、8 回の試行後に安全に失敗します。ID のない text/table はホイールでスクロールできますが、キーボードフォーカスや明示的な状態管理には安定した ID が必要です。

`onEvent(event, data, view)` は、`{ id, key }` を持つ `select`/`activate`、`{ id, key, expanded }` を持つ `toggle`、`{ id, key }` を持つ `tab`、`{ id, value }` を持つ `submit`、または `{ key, focused? }` を持つ宣言済みの `key` を受け取ります。イベントは `type` を判別子として使用します。ショートカットは `keys` で宣言してください（たとえば `keys: [{ key: "x", label: "stop" }]`）。宣言的なビューは、従来の `run` コールバックではなく、`onEvent` でこれらを受け取ります。未宣言のキーはイベントを発行しません。ホストはハンドラーを呼ぶ前に状態を変更するため、`view.setState(patch)` でデフォルトの動作を上書きできます。パッチは浅い更新です。指定したトップレベルのマップは、そのマップ全体を置き換え、個々のエントリを更新するわけではありません。他のエントリを保持する場合は、`{ ...ctx.state.selected, [id]: key }` を使用してください。`view.focus(id)` は見えるウィジェットにフォーカスします。既存の `close`、`requestRender`、`print`、`prompt`、`confirm` メソッドも引き続き使用できます。submit しても入力欄は自動では空になりません。

`needsTab: true` の場合、Tab/Shift+Tab は、表示されている tree、ID 付きの table/text、タブ列、input の間を移動します。フォーカス可能なウィジェットがない場合は、代わりに `onEvent` を通じて宣言済みの `tab`/`shift-tab` ショートカットに届きます。未宣言のキーは何も発行しません。それ以外では、Tab はホストのフォーカスを入力欄へ切り替えます。tree では、Up/Down で選択し、Right で展開し、Left で折りたたむか親を選択し、Enter で項目を実行します。table は Up/Down で選択、Enter で実行します。タブ列は Left/Right で切り替え、input は Enter で送信します。ページ移動用のキーと Home/End は、フォーカスしたスクロール可能な要素をスクロールします。ホイールは、フォーカスや選択を動かさずに、ポインターの下のウィジェットをスクロールします。text が内容の増加に追従するのは、`follow: true` の場合、または末尾までスクロールした後だけです。上へスクロールすると追従を止めます。ウィジェットのキーは宣言済みのショートカットより優先され、残りの宣言済みキーは `onEvent` に届きます。Esc はまず開いている質問・確認をキャンセルし、次に `activate` を持つ input から離れ、それ以外はページを戻るかルートを閉じます。Ctrl+C は常にビュー全体を閉じます。q は、フォーカスした宣言的な input や質問のオーバーレイがテキスト入力として受け取る場合を除いて、ビューを閉じます。質問・確認のオーバーレイは、ウィジェット入力を一時停止し、カーソルを管理します。

ビューは、入力、データ更新、`requestRender` で再描画します。ウィジェットのアニメーション用タイマーは追加されません。展開された tree の行は、準備処理 1 回につき 1 回だけインデックス化され、ビューポート内の行だけを描画します。テスト専用の意味に基づくダッシュボードの実証例と、その 180×52/80×24 のスナップショットは `packages/tui/test/ui-runtime` にあります。再現可能な 500 項目の入れ子の tree のベンチマークを実行するには、`bun packages/tui/test/ui-runtime/benchmark.ts` を使います。180×50 で、80 個のウィジェットカードの詳細、タイムラインのスタイル、展開・折りたたみのケース、`ExtensionViewer` 全体の処理経路を含みます。ウィジェットの詳細は、展開した項目だけで測定し、ビューポートと重なる部分だけを描画します。

### ツールの能力

ツールの名前に頼るのではなく、ホストから見える能力を `traits` で宣言してください。`readOnly: true` は plan モードでツールを許可します。`writesFiles: true` はファイルに書き込むツールを示し、`writesFiles: "paths"` は `getWrittenPaths(params, { cwd })` が、その呼び出しで書き込む可能性のあるすべてのパスを、`cwd` からの相対パスまたは絶対パスで返すことを宣言します。有効なパス報告を持つ書き込みツールには、限定的な[拡張機能の状態ディレクトリ](#拡張機能の状態ディレクトリ)の免除を除き、組み込みのファイルツールと同じ保護対象パスの確認を行います。ホストは巻き戻し用に変更前後のファイル内容を記録します。報告が欠けているか不正な場合は、安全側に扱い、承認を求めます。すでに `ctx.mutateFiles` を使用するツールは、ホストが巻き戻しの境界を重複して追加しないよう `usesMutationHook: true` を設定してください。

コマンドを実行するツールには、`shell: "bash"` または `shell: "powershell"` を設定します。実際のシェルを実行時に選択する場合は、`shellKind()` も使用してください。編集ツールの代替には `editor: "edit"` または `editor: "apply_patch"`、保存済みの出力を読むツールには `artifactReader: true`、遅延ツールのローダーには `toolSearch: true`、UI が必要なツールには `interactive: true` を設定します。`readKey(params, { cwd })` は、コンテキストの重複排除のため、繰り返し可能な直接のファイル読み取りを識別できます。省略した traits は不明のままです。権限確認、巻き戻し、ワークスペースの更新は安全側の動作を維持します。現時点で MCP ツールは既知の traits を宣言しません。

traits は信頼されます。拡張機能はあなた自身のコードとして実行されるため、独自の名前のツールが `readOnly` を宣言したり、実際に書き込むより少ないパスを報告したりしても、その宣言を信頼します。ただし、宣言で組み込みの名前の能力を弱めることはできません。`write`、`edit`、`apply_patch`、`bash`、`powershell`、`monitor`、`ask_user` として登録したツール（たとえば `override`）は、宣言にかかわらず、その名前が意味する能力を維持します。`write`、`edit`、`apply_patch` は常にファイル書き込みツールで、報告したパスに加えて、引数で指定されたパスも確認します。`bash`、`powershell`、`monitor` は、常にコマンドルールの対象となるシェルツールです（`shellKind()` が応答しない限り、bash と monitor のコマンドは両方のシェルの解釈で確認します）。これらはいずれも plan モードで読み取り専用とは扱われません。ファイル書き込みとシェル実行の両方を行うツールは、両方として確認されます。巻き戻しは、書き込みを宣言したツールが報告するパスだけを記録します。`usesMutationHook: true` は、ツール自身が `ctx.mutateFiles` で書き込みを記録することをホストに伝えます。そう宣言して実際には行わないツールの書き込みは記録されません。ホストが宣言済みの書き込みツールの変更を記録する間、呼び出し全体がセッションのファイル記録キューを占有します。同じディレクトリのサブエージェントを含め、他のファイル書き込みは待機します。そのため、この種のツールは短時間で完了させ、他のエージェントのファイル書き込みを待つことは決してしないでください。

ホストは before インターセプターと承認の前に `shellKind()` の結果を固定し、実行時に `ctx.shellKind` として渡します。`monitor` は、選択された `bash` または `powershell` の名前に対応するガードも、`command` と `background: true` を指定して通過します。シェルツールの無効化も有効です。シェルを特定できない場合は、両方のシェルのガードとコマンドルールを確認します。monitor 自身のガードも適用し、バックグラウンド実行を禁止するシェルガードを無視することはできません。承認待ちの間に monitor のシェル選択が変わった場合、呼び出しを拒否して再試行を求めます。実行直前には、承認時に固定した入口が現在のホストポリシーで許可されていることも確認します。

`serverToolView(block)` は、プロバイダーのツール名、引数、結果テキスト、ソースを含むネイティブ検索の詳細を返します。ブロックが完了しなかった場合には、`rejected: "aborted"` も返します。返された `ToolCallView` のフィールドは、既存のツール表示処理や他のフロントエンドで使用してください。描画専用であり、ローカルのツール結果として送り返してはいけません。

コマンドから `ctx.openRewind()` を使うと、Esc を 2 回押したときと同じ巻き戻しの選択画面を開きます。これは、選択画面を持つフロントエンド（端末 UI）でのみ設定されます。ターン中など、今すぐ開けない場合は false を返します。

`SessionControl.rewind(index)` は、記録したファイル変更をデフォルトで復元します。復元を引き継ぐ拡張機能がなく、コアのファイル履歴が無効、利用不可、または削除済みの場合は、理由を示して呼び出しを拒否します。会話だけの巻き戻しへ暗黙に切り替えることはありません。拒否した場合、会話は変更されません。会話だけを巻き戻すには、`{ restoreFiles: false }` を明示的に渡してください。`planRewind(index)` で復元の可否を確認でき、`note` に理由が示されます。

拡張機能固有の設定は、`extensions` 配下に拡張機能名を付けて保存します。設定のスナップショットは深く凍結されています。自分のセクションは自分で検証してください。`api.settings.layers(key)` は、トップレベルのキーに明示的に設定された値を優先順位順に返します。各値には `scope`（`user`、`project`、`project-local`、`flags`）、`file`、`value` が含まれます。キーがない場合は空の一覧を返します。ホストは、`/reload` も含め、設定を再読み込みするたびに新しいスナップショットとレイヤーマップを提供します。そのため、拡張機能は自ら設定ファイルを読まずに、長期間保持するリソースを更新された設定に合わせられます。print モードは UI ダイアログをキャンセルします。RPC クライアントはプロトコルを通じて回答します。パネル、ビュー、ツール表示処理、Markdown レンダラー、画像プロバイダー、サービスは実験的な API です。

`runCommand` は、コマンドが終了した時点で解決します。出力を受信するたびに取得するには `onChunk` を渡してください。たとえば、長い `git` コマンドの進捗表示に使えます。`signal` で中止するか、`timeoutMs` が経過すると、プロセスツリー全体を終了します。この場合、結果は `aborted` または `timedOut` を報告します。デフォルトでは、`output` は末尾の 1,000,000 文字だけを保持します。正の整数の `maxOutputChars` でこの上限を変更できます（不正な値では呼び出しを拒否します）。`onChunk` は引き続きすべての出力を受け取り、`truncated` は `output` が切り詰められたかどうかを報告します。切り詰めによって UTF-16 サロゲートペアを分割することはありません。

`complete({ messages, system?, model?, maxTokens?, signal?, label? })` は、会話の外でモデルへのリクエストを 1 回行います。ツールはなく、ホスト型 Web 検索も無効です。返信のテキスト、メッセージ、使用量で解決します。デフォルトではセッションの現在のモデルを使用します（`model` は `provider/model` 形式の参照を受け付けます）。このようなリクエストは毎回トークンを消費します。使用量はセッションに保存され、`/cost` に `label`（未指定なら拡張機能の取得元）の下で表示され、エージェントツリーの `budget` に計上されます。予算を使い切ると、リクエストを送らずに呼び出しを拒否します。推論モデルには、思考後に回答できるよう、モデルの上限内で少なくとも 2,048 出力トークンが割り当てられます。プロバイダーのエラーは Promise を拒否します。`signal` の中止や拡張機能のアンロードでは、`AbortError` で拒否します。`session()` は、ホストが構築済みであれば、トップレベルのセッションの `SessionControl` を返します。`rename(title, { source: "auto", sessionId })` は、`/rename` で設定した名前を置き換えることはなく、`sessionId` が現在のセッションでなくなっていれば何もしません。

`api.complete` は現在のメインセッションに計上し、owned conversation には計上しません。`label` は帰属の上書きではありません。所有者別の会計には、上記の紐づいた `OwnedConversation.complete` を使い、固定モデルと同じテキスト専用の動作を維持してください。どちらの経路も、拒否前に報告済みの再試行/エラー/中止の使用量を計上します。成功結果の `usage` だけでは完全な台帳になりません。使用量が報告されないリクエストは不明であり、無料とは扱いません。

### セッションの推論の強度

API 0.1.20 では `SessionControl.setThinking(level: ReasoningEffort | undefined): void` が追加されています。コマンドのコンテキストか `api.session()` から制御オブジェクトを取得してください。後者は、ホストが注入する前には `undefined` を返すことがあります。使用可能な強度は `low`、`medium`、`high`、`xhigh`、`max` です。この上書きはセッション内だけで有効で、設定を書き込みません。`--thinking`、モデルごとの設定、トップレベルの設定という順の優先順位よりも優先されます。`undefined` を渡すと、これらすべての取得元を明示的に抑制し、強度を送信せずにサーバーのデフォルト値を適用します。実行時の上書きを解除するわけではありません。

`setThinking` は、ターン、圧縮、再読み込みの実行中には例外を投げます。選択は、後から使用する思考モデルにも保持され、変更後に生成したサブエージェントにも継承されます。現在のモデルと同様に、`/clear`、`/resume`、巻き戻し、フォークで切り替えた会話にも引き継がれます。メモリ内にのみ保持するため、新しい Amira プロセスは、フラグと設定から再び開始します。

`ui.select(title, options, { initial, signal })` は、選択画面を開く際に強調表示する、任意の `initial` の選択肢ラベルを受け付けます。一致するラベルがなければ、最初の選択肢を強調表示します。選択画面をキャンセルすると `undefined` を返します。組み込みの強度選択画面をキャンセルした場合は、現在の選択を変更しません。

`SessionControl.info()` は、次の `SessionInfo` フィールドを返します。

| フィールド | 意味 |
| --- | --- |
| `thinking?: ReasoningEffort` | 現在のモデルに送信する推論の強度。未設定、またはモデルが思考をサポートしない場合はありません |
| `thinkingLevel?: ReasoningEffort` | 現在のモデルの能力にかかわらない実効的な選択。思考をサポートしないモデルに切り替えても保持されます |
| `supportsThinking?: boolean` | 現在のモデルが思考をサポートするかどうか。Amira のホストは boolean を提供します |

型付きイベント `thinking.changed` は `{ thinking?: ReasoningEffort }` をペイロードに持ち、実行時の強度が変わると発行されます。その `thinking` フィールドは、`thinkingLevel` ではなく、モデルの能力によって有無が決まる `info().thinking` と同じ意味です。ライブ表示では、`api.session()?.info()` を読み取り、モデルとセッションの変更に加え、`thinking.changed` でも再描画してください。トップレベルのセッションだけを表示する場合は、`parentSessionId` のあるイベントを無視します。組み込みのステータスバーは、`info().thinking` が設定されている場合だけ、モデル名の横に強度を表示します。

### セッションのトレース

ホストは、セッションごとの可観測性トレースを記録します（D103）。ビューアーは別のリポジトリにあります。読み込む必要のある拡張機能ではなく、エージェントのループや `API_VERSION` を変更しません。`<session file>` に永続化されたセッションには、対応する `<session file>.trace.jsonl` があります。永続化された各子にも、入れ子の子孫を含め、`subagents/` 配下のセッションファイルの隣に対応するファイルがあります。一時的なセッションや、会話ファイルがまだ作成されていないセッションでは、トレースファイルは生成されません。

`SessionControl.trace(sessionId?: string): Promise<TraceRecord[]>` は、引数を省略すると現在のセッションのトレースを読み取ります。`sessionId` を指定すると、`subagents()` に掲載された子孫のトレースも読み取れます。制御オブジェクトは `api.session()` またはコマンドの `ctx.session` から取得してください。無関係な ID、トレースのないセッション、存在しないファイルには `[]` を返します。任意のファイルを読み取る API ではありません。結果は完了済みのレコードのスナップショットで、読み取りのために書き出された、完了済みの記録バッファも含みます。実行中の処理に対する区間を合成することはありません。イベントバスをすべて処理するわけではないため、レコーダーにまだ届いていないイベントは含まれないことがあります。イベントリスナーから呼び出しても、そのリスナーを待機しません。読み取り処理は、不正または書き込み途中の行と、サポートされていないバージョンの記録実行をスキップします。

```ts
import { summarizeTrace } from "@amira/api"

const session = api.session()
if (session) {
  const records = await session.trace()
  const summary = summarizeTrace(records)
  const child = session.subagents()[0]
  const childRecords = child ? await session.trace(child.id) : []
}
```

書き込みは非同期のバッチ処理で、少なくとも毎秒 1 回スケジュールされ、セッション終了時とプロセス終了時に書き出されます。ディスク I/O のためにターンを待機させることはありません。記録の失敗はセッションごとに 1 回だけ報告し、エージェントを失敗させません。トレースの永続化はベストエフォートです。突然の終了や、購読者の過負荷によってイベントを失うことがあります。再開時は、既存のトレースを切り詰めず、新しいヘッダーを追加します。フォークは会話をコピーしますが、トレースはコピーしません。フォークは記録時に独自のトレースを開始します。セッションを削除すると、そのトレースと所有する子孫のトレースを削除しますが、別のセッションとまだ共有している子孫は保持します。

#### レコード形式とプライバシー

`@amira/api` は `TRACE_VERSION = 1`、`TraceRecord`、`ToolOutcome`、`TraceSummary`、`summarizeTrace` をエクスポートします。JSONL の各行が 1 レコードで、記録実行ごとに先頭に `trace` ヘッダーがあります。次の表は、判別子 `type` 以外のすべてのフィールドを示します。任意の列のフィールドは省略できます。`Usage` は、公開のトークン・検索・USD コストの使用量の型です。モデルの文字列には `provider/model` 形式を使用します。

| `type` | 必須フィールド | 任意フィールド |
| --- | --- | --- |
| `trace` | `v: 1`, `sessionId: string`, `startedAt: number` | `parentSessionId: string`, `role: string`, `title: string` |
| `turn` | `turnId: string`, `start: number`, `end: number`, `reason: "done" \| "error" \| "aborted"`, `steps: number` | `failure: { kind: string; message: string }` |
| `model` | `model: string`, `start: number`, `end: number` | `turnId: string`, `firstToken: number`, `usage: Usage`, `stopReason: string`, `retries: { at: number; delayMs: number; kind: string }[]` |
| `tool` | `toolCallId: string`, `name: string`, `start: number`, `end: number`, `durationMs: number`, `outcome: ToolOutcome`, `argsChars: number`, `resultChars: number`, `argsPreview: string`, `resultPreview: string` | `turnId: string`, `approvalWaitMs: number`, `approval: "user" \| "rule"`, `artifact: string`, `writtenPaths: string[]` |
| `status` | `at: number`, `status: "idle" \| "working" \| "blocked" \| "error"` | `reason: string` |
| `subagent` | `childSessionId: string`, `start: number`, `end: number`, `status: string`, `durationMs: number` | `toolCallId: string`, `role: string`, `title: string`, `groupId: string`, `queuedAt: number`, `error: string`, `usage: Usage` |
| `compact` | `start: number`, `end: number`, `reason: string` | `tokensBefore: number`, `tokensAfter: number`, `usage: Usage`, `native: boolean`, `fallback: boolean` |
| `side` | `at: number`, `model: string` | `label: string`, `usage: Usage` |

すべてのタイムスタンプ（`startedAt`、`start`、`end`、`at`、`firstToken`、`queuedAt`）は、追記時刻ではなく、イベントエンベロープの `ts` 値に由来する、エポックからのミリ秒です。所要時間と再試行の遅延もミリ秒です。区間レコードは終了時に追記されるため、ファイル内の順序は開始時刻順ではありません。ターンは `turn.start/end` を対応付けます。モデルのレコードは `message.start/end` を対応付け、そのリクエスト内の再試行を保持します。`firstToken` は、テキスト、思考、ツール呼び出しのいずれであっても、最初に確実に観測したメッセージ差分です。差分がない、または失われた場合は存在しないことがあります。失敗したターンには、構造化された失敗情報の kind と要約を使用し、分類されていないエラーでは kind を `"other"` にします。

ツール引数のプレビューはコンパクトな JSON です。結果のプレビューにはテキストブロックだけを含みます。各プレビューは最大 300 Unicode コードポイントで、サロゲートペアを分割しません。`argsChars` はコンパクトな JSON のコードポイント数、`resultChars` は出力した結果テキストのコードポイント数を数えます。後者は、すでに元の出力ではなくアーティファクトのプレビューを示している場合があります。`artifact` は保存済み出力の ID で、パスではありません。画像、結果の details、引数・結果の全文はトレースにコピーしません。完全なコンテンツはセッション・アーティファクトのストレージに残ります。プレビューやパスにも機密のテキストが含まれる場合があるため、トレースは非公開のセッションデータとして扱ってください。

`ToolOutcome` は `"ok" | "error" | "denied" | "aborted" | "invalid" | "unknown-tool"` です。拒否が優先されます。`tool.execute.end.rejected` の値 `blocked`、`aborted`、`invalidArgs`、`unknownTool` は、それぞれ `denied`、`aborted`、`invalid`、`unknown-tool` に対応します。それ以外では、`result.isError` で `error` または `ok` を選びます。結果テキストから中止を推測することはありません。開始と終了は、セッション、ターン、呼び出し ID、ツール名で対応付け、キーが繰り返される場合は FIFO を使います。同じ並列バッチ内の ID・名前が同一の呼び出しが順不同で終了した場合は区別できないため、対応する開始やプレビューが曖昧になることがあります。

`tool.execute.end.waitedMs?: number` は、承認者を実際に待った時間だけを測定し、トレースの `approvalWaitMs` になります。実際の待機時間がゼロなら `0` として保持します。待機しなかった呼び出し、ポリシーによる直接の拒否、承認者が不在の場合、ツールの質問待ちでは、このフィールドはありません。`durationMs` は実行だけを測定し、承認、実行前の確認、呼び出し前後のインターセプターは除きます。実行前に拒否された呼び出しはゼロを報告します。ツールの開始・終了イベントの区間には、スケジュールや後処理が含まれることもあるため、`durationMs` と同じとは限りません。同時に行われる承認待ちは重なることがあり、経過時間にそのまま加算するものではありません。

親の `subagent` レコードは、完了した直接の子と、その子自身の使用量を表します。子孫を再帰的に合計した使用量ではありません。`queuedAt` は、`subagent.start` がキュー内の子を通知した場合だけ存在します。実行の `start` は、子の実際の `session.start` に由来します。この通知前にキャンセルされた子は `start === end` となり、実行区間がないことを示します。報告される子の `durationMs` は、実行許可後の生存期間で、永続的な子ではアイドル期間を含む場合があります。各子自身のトレースに、そのターン・モデル・ツールの詳細が含まれます。

圧縮レコードには、要約テキストを決して含めません。成功したレコードには、トリガーとなった理由と、任意のトークン数・使用量が含まれます。`native` と `fallback` は boolean で、元のモデル参照やフォールバックの説明ではありません。失敗した試行には、`reason: "failure:blocked"`、`"failure:empty"`、`"failure:error"` を使います。先行する開始がなければ、`start === end` になります。`side` の種別は形式として予約されていますが、現在のホストは補助リクエストの使用量イベントを発行しないため、`side` レコードは書き込まれません。保存済みの `side_usage` エントリや予算の更新をポーリングしたり、トレースに変換したりすることもありません。保存済みの補助リクエストの計上情報には `sideRequests()` を使用してください。

#### トレースの集計

`summarizeTrace(records: TraceRecord[]): TraceSummary` は純粋関数で、入力を変更しません。再開ヘッダーも含めて、1 つのセッションのトレースを渡してください。親の subagent レコードはすでに子の使用量を報告しているため、親と子のトレースを連結しないでください。時間の指標は重なるため、足し合わせて経過時間を再構築してはいけません。

| 集計フィールド | 計上方法 |
| --- | --- |
| `start?`, `end?`, `wallTimeMs` | キュー・再試行の時間も含む、記録に表された最も早いイベント時刻と最も遅いイベント時刻。経過時間はそれらの差で、配列の両端間の時間ではありません。再開までの停止時間も含みます。空の入力には開始・終了がなく、時間はゼロです |
| `modelTimeMs` | 再試行の遅延を含む、モデルリクエストの区間の合計 |
| `modelWaitMs`, `modelStreamMs`, `modelUnknownMs` | `firstToken` がある場合の、開始から最初のトークンまでと、最初のトークンから終了までの時間の合計。ない場合は、区間全体を `modelUnknownMs` の未分類時間とします |
| `toolTimeMs` | ツールの開始・終了区間の和集合。重なる並列呼び出しは 1 回だけ数えます |
| `toolDurationMs`, `approvalWaitMs` | 報告されたツールの実行時間と、実際の承認待ちをそれぞれ独立して合計します。同時の待機は重なる場合があります |
| `idleMs` | ヘッダーで区切られた各実行内の、ターン区間の間の空白時間。再開までの停止時間と、最初・最後のターンの外側の時間は除きます |
| `usage`, `subagentUsage`, `totalUsage` | 自身の model/compact/side の使用量、直接の子自身の使用量、その合計。推論トークンは保持します。含まれる使用量にコスト不明のものがあれば、総コストはありません。価格不明の検索は不明のままです |
| `tools[name]` | 報告された `durationMs` に基づく `count`、`totalMs`、`avgMs`、`maxMs` と、ゼロも含む 6 種類すべての処理結果の件数を持つ `outcomes` |
| `failures` | OK 以外のすべてのツールと、失敗・中止したターン。完了時の `at` 順で、取得元の識別子、結果・理由、利用可能な長さ制限付きツールプレビュー、またはターンの失敗要約を含みます |
| `retries` | 記録されたモデルの再試行エントリの数 |
| `subagents` | 完了した直接の子。ID、任意の role/title、開始・終了、報告された生存期間の所要時間、状態、任意の使用量、判明している USD の `cost` を含みます |

使用量の合計は、報告された使用量だけを対象にし、すべての課金対象の処理を対象にするわけではありません。特に、補助リクエストの使用量イベントがない場合、モデルイベントのない親モデルへの相談や、報告されなかった失敗リクエストの使用量は、トレースから再構築できません。子の詳細な時間や子孫が必要な場合は、その子のトレースを別に読み取ってください。トレースと `budget.update` のペイロードは所有者の台帳ではなく、請求書の網羅性も保証しません。所有者の会計には `OwnedConversation.usage()`、または `OwnedConversations.read(ref)` を await して結果を確認した後の `usage` を使用し、メインに紐づく `sideRequests()` やトレースの合計を使わないでください。トレース/runner/group の合計をスナップショットの `total` に再加算せず、`knownCostUsd`、不完全な網羅性、revision による符号付き訂正を保持してください。

### ワークスペースのプロバイダー

API 0.1.16 では `api.registerWorkspaceProvider(provider)` が追加されています。ホストごとに登録できるプロバイダーは 1 つです。2 回目の登録は、現在の所有者の名前を含むエラーを投げます。戻り値の関数で登録を解除できます。アンロード、読み込み失敗、再読み込みでは、自動的に解放されます。

```ts
import type { WorkspaceProvider } from "@amira/api"

const provider: WorkspaceProvider = {
  async probe(cwd, signal, kind = "full") {
    // Honor signal; use api.runCommand for processes. A dirty probe may reuse metadata.
    return { cwd }
  },
  // Optional: a cheap metadata fingerprint, with no process spawn.
  stamp(cwd) { return undefined },
}
api.registerWorkspaceProvider(provider)
```

`WorkspaceFacts` は `workspace.changed` のペイロードです。`cwd` と、任意の `repoRoot`、`branch`、`head`、`isWorktree`、`dirty` を持ちます。要求された `cwd` をそのまま返してください。不一致は拒否されます。情報が取得できない場合は `undefined` を返します。プロバイダー自身がイベントを発行したり、`sessionId`、`seq`、`ts` を提供したりすることはありません。ホストがこれらのフィールドを管理し、結果をアクティブなトップレベルのセッションに紐づけます。セッションの切り替え、セッション終了、プロバイダーの削除では、実行中の調査を中止し、プロバイダーがキャンセルを無視しても遅れて届いた結果を破棄します。

ホストは最初に 500 ms 待機し、重なったリクエストをまとめ、変更された情報だけを発行します。stamp が変わった場合は、ターン後に完全な調査を行います。stamp が変わっていない場合は、ファイルに書き込む可能性のあるツールの後、または 60 秒間確認していない場合に、未コミットの変更の調査を要求します。書き込みのヒントをスキップするのは、明示的な `writesFiles: false` だけです。不明なツールや子のツールは安全側に扱います。stamp がない場合は、毎ターン終了後に完全な調査を要求します。stamp は、リポジトリの出現や消失も反映する必要があります。プロバイダーは、未コミットの変更の調査要求に対して、完全な情報を返してもかまいません。

組み込みのエージェント拡張機能が Git の調査を提供します。`--no-builtins` を使い、代替のプロバイダーがない場合、ワークスペースのイベントやブランチのラベルはありません。`/status` は 2 秒後に待機を打ち切り、Git の情報が不明であると報告します。再読み込みは、現在のセッションの最後のワークスペースイベントを再送します。非推奨の `@amira/core` のエクスポートも引き続き使用できます。`gitInfo` は、プロバイダーが不要な、独立した 1 回限りの Git 調査として残ります。`trackWorkspace` は、そのバス上のホストの追跡処理を開始・再開します。そのバスにプロバイダーが登録されるまで、イベントは発行されません。

### バックグラウンドジョブ

`ExtensionAPI.backgroundJobs` は、拡張機能のスコープに限定したアクセス手段です。ジョブを開始でき、同じ拡張機能が開始したジョブだけを一覧表示、読み取り、待機、停止、購読できます。ホストのレジストリの設定、すべてのジョブの停止、セッションの終了、ルート間のジョブの引き渡しはできません。`/jobs` コマンドや TUI パネルなどの組み込みフロントエンドのコードは、ホスト専用の `hostBackgroundJobs()` 機能を使用するため、ツールが開始したセッションのジョブを見ることができます。ツールの実行処理では、代わりにセッションのスコープに限定された `ctx.backgroundJobs` 機能を使用してください。こちらは所有者と可視範囲の情報を持ちます。

ジョブは `command`、`argv`、`cwd`、`env`、`shell` を指定して開始します。セッションのホストは、所有するサブエージェントを自動的に記録します。メインのセッションは、自身のジョブと配下のサブエージェントのすべてのジョブを見ることができます。サブエージェントは、自身のジョブだけを見ることができます。`list`、`get`、`running`、`output`、`tail`、`stop` はこの可視範囲を適用し、アクセスできないジョブは存在しないものとして扱います。

開始オプションの `onChange(change)` を指定すると、同期的な起動出力や終了時のスナップショットを含め、そのジョブの最初のイベントから監視できます。出力イベントの `output` は、新しく届いた生の出力で、保持バッファーのサイズとは独立しています。必要な行の組み立て状態を監視側で保持し、終了情報はジョブが削除された後に再取得せず、その場で記録してください。監視側の例外はジョブのライフサイクルから隔離されます。

`readNew` は読み取り側の名前ごとにカーソルを保持するため、独立した読み取り側が同じ出力を順次読み取れます。`waitFor` は、正規表現パターン、プロセス終了、タイムアウト、中止シグナルのいずれかを待ちます。`subscribe` は、その拡張機能のジョブの変更だけを報告します。まず猶予期間を指定して `stop` を呼び出し、強制停止が必要な場合は `0` でもう一度呼び出してください。

ホストのレジストリは、組み込みのホストコードに `maxRunning`、`configure`、`stopAll`、`isLimitError` を公開します。サブエージェントのセッションが所有するジョブは、その `subagent.end` イベントの配信後に自動的に停止します。トップレベルのセッションが所有するジョブは、`/clear`、`/resume`、`/fork` を越えて継続します。置き換え後のルートセッションは、それらを一覧表示、読み取り、停止でき、終了通知もそこで届きます。`ExtensionAPI.backgroundJobs` を直接使用して開始したジョブは、呼び出し元のセッションには割り当てられません。開始した拡張機能のアンロード時（その `subscribe` リスナーも削除されます）、または Amira の終了時に停止します。`/reload` を含め、拡張機能をアンロードしても、セッションのツールが開始したジョブは停止しません。拡張機能は、`@amira/proc` のグローバルに直接アクセスせず、範囲を絞った API を使用する必要があります。

登録処理は削除用の関数を返し、ホストが追跡します。アンロードで登録は削除され、拡張機能の読み込みに失敗すると、その登録はロールバックされます。コマンド、ツール、スキル、ステータス、パネルの名前が一致する場合、意図的な置き換えには `override: true` が必要です。重複時の規則は個々の型を確認してください。他の拡張機能の登録を誤って置き換えないでください。

イベントには `session.start`（任意の初期 `title` 付き）、`workspace.changed`、`tool.execute.start`、`tool.execute.end` があります。ツールの開始・終了の両方に、そのツールの `traits` と、書き込みツールの場合は報告した `writtenPaths` が含まれます。イベントリスナーは、イベントデータとセッション ID を含むエンベロープを受け取るため、セッション固有の状態を維持する際はセッションで絞り込んでください。再読み込み時は、新しく登録したリスナーに、現在のセッション・ワークスペース・予算のイベントと、最新の `ui.focus` と `ui.waiting` の状態が再送されます。待機状態は、新しい質問を通知せず、可視性の変更として再送します。自分で作成したネイティブリソースには、独自のクリーンアップが必要です。

`message.stream` は、表示される `message.delta` の種別を変えずに、構造的なタイミングイベントを追加します。`kind` は `request`（プロバイダーへの各試行の直前に送信し、実際のリクエストに由来する任意の `thinkingDisplay: "summarized" | "omitted" | "raw"` を持ちます）、`contentStart`、`thinkingStart`、`thinkingEnd`（任意のブロック `index`）、または `end`（プロバイダーの最後のイベントで、任意の報告された `outputTokens`）です。読めるテキストのないブロックでも境界は発行されます。購読者の実行時刻ではなく、エンベロープの `ts` を使用してください。再試行をまたいで、各リクエストの時計を別々に保持します。`turn.start.sentAt` は任意で、プロンプトが圧縮を待つ場合に、元のプロンプト時刻を保持します。これらの追加は RPC スキーマにも記述されています。クライアントは、新しいイベントの種別や任意フィールドの欠落を許容してください。`Usage.outputReported: false` は、検索のみの使用量メタデータを、出力がゼロと報告された場合と区別します。出力数が報告されている場合は省略してください。`compact.failed` は、任意の `usage` と `requested` を持てるようになりました。`compact.end` と `compact.failed` は、試行が使用量を報告しなかった場合に `usageIncomplete` を持つことができます。これにより、ターンの統計で部分的な合計を完全な合計と誤認することを防ぎます。

複数のイベントにまたがるタイミング・状態の管理には、任意の `api.onEvents(types, handler)` を使用してください。選択した種別を 1 つの順序付きキューで配信し、購読者ごとの `events.lost` を含み、該当する現在の状態のイベントを再送し、アンロード時に削除されます。個別の `api.on` 購読は、独立したキューを持ち、イベント種別をまたぐ順序を保証しません。`onEvents` のないホストは、順序を保ったタイミング収集機能を提供できません。

`api.terminal` は、安定した構造化機能です。`setTitle(title: string)`、`setProgress(state: "none" | "indeterminate" | "paused")`、`bell()` を提供します。生の書き込みやエスケープシーケンスは公開しません。print と RPC のフロントエンドでは、これらのメソッドは何もしません。TUI は、タイトルをサニタイズして端末の 128 セルに制限し、フレームの書き込み外のマイクロタスク境界で効果をまとめ、`tui.title`、`tui.progress`、`tui.bell` の設定を尊重し、進捗表示の対応状況を検出し、終了時に端末を復元します。

組み込みの `@amira/ext-terminal-status` は、タイトルの構成、作業中・待機中の進捗表示、ベルのポリシーを管理します。`--no-builtins` で無効になります。TUI は、質問（ローカルの巻き戻しダイアログも含みます）、フォーム、オーバーレイの変更後に `ui.waiting` を発行します。形式は `{ pending: number, hidden: boolean, change: "opened" | "resolved" | "visibility" }` です。`hidden` は、オーバーレイが回答待ちの質問を覆っていることを意味します。隠れた状態で質問が開くと 1 回ベルが鳴り、可視性の変更では鳴りません。フォーカスの報告は `ui.focus` として届きます。完了時と、表示される質問では、フォーカスがない場合にベルが鳴ります。フォーカスが不明の場合は、ターン開始から 15 秒経過後に鳴ります。中止されたターンでは鳴りません。

拡張機能のエントリファイルを編集したら、`/reload` を使用してください。そのファイルからインポートしたモジュールはキャッシュされたままなので、ヘルパーモジュールを変更したら Amira を再起動してください。描画コールバックは軽量に保ち、表示される状態を変えたら `requestRender` を呼び出してください。

関連: [はじめに](getting-started.md)、[サブエージェント](subagents.md)、[使い方とセッション](usage.md)、[設定](settings.md)、[キー割り当て](keybindings.md)。
